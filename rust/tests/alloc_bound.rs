use hyperfly_core::{Codec, Field, Limits, Node, Plan, Value};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountingAllocator;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn track_alloc(size: usize) {
    let current = CURRENT.fetch_add(size, Ordering::SeqCst) + size;
    PEAK.fetch_max(current, Ordering::SeqCst);
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            track_alloc(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc_zeroed(layout);
        if !ptr.is_null() {
            track_alloc(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        CURRENT.fetch_sub(layout.size(), Ordering::SeqCst);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = System.realloc(ptr, layout, new_size);
        if !new_ptr.is_null() {
            if new_size >= layout.size() {
                track_alloc(new_size - layout.size());
            } else {
                CURRENT.fetch_sub(layout.size() - new_size, Ordering::SeqCst);
            }
        }
        new_ptr
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn write_uleb(out: &mut Vec<u8>, mut value: usize) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn packed_body(expected: usize, blob: &[u8]) -> Vec<u8> {
    let mut body = vec![1, 2]; // One row, packed string column.
    write_uleb(&mut body, expected);
    write_uleb(&mut body, blob.len());
    body.extend_from_slice(blob);
    body
}

fn string_row(s: String) -> Value {
    Value::Array(vec![Value::Object(vec![("s".into(), Value::Str(s))])])
}

#[test]
fn packed_inflate_bounds_allocation_and_preserves_validation() {
    let ir = Node::Array {
        element: Box::new(Node::Struct(vec![Field {
            name: "s".into(),
            ty: Node::Str,
            optional: false,
            nullable: false,
        }])),
        length: None,
    };
    let codec = Codec::compile(ir, Plan::Columnar, Limits::default(), true).unwrap();

    for blob in [&[0xff][..], &[0x03, 0x00][..], &[0x01][..]] {
        let body = packed_body((1 << 28) - 1, blob);
        let baseline = CURRENT.load(Ordering::SeqCst);
        PEAK.store(baseline, Ordering::SeqCst);
        let result = codec.decode_body(&body);
        let peak = PEAK.load(Ordering::SeqCst).saturating_sub(baseline);
        assert_eq!(result.unwrap_err().code.as_str(), "packed");
        assert!(peak < 16 * 1024 * 1024, "decode allocated {peak} bytes");
    }

    for len in [0, 1, 64 * 1024, 64 * 1024 + 1, 300_000] {
        let text = "x".repeat(len);
        let blob = miniz_oxide::deflate::compress_to_vec(text.as_bytes(), 6);
        let body = packed_body(len, &blob);
        let value = string_row(text);
        assert_eq!(codec.decode_body(&body).unwrap(), value);
        let encoded = codec.encode_body(&value).unwrap();
        if len > 1 {
            assert_eq!(encoded[1], 2, "encoder should select packing");
        }
        assert_eq!(codec.decode_body(&encoded).unwrap(), value);

        let mut trailing_blob = blob.clone();
        trailing_blob.push(0);
        let mut invalid_bodies = vec![
            packed_body(len, &trailing_blob),
            packed_body(len, &blob[..blob.len() - 1]),
            packed_body(len + 1, &blob),
        ];
        if len > 0 {
            invalid_bodies.push(packed_body(len - 1, &blob));
        }
        for invalid in invalid_bodies {
            assert_eq!(
                codec.decode_body(&invalid).unwrap_err().code.as_str(),
                "packed"
            );
        }
    }
}
