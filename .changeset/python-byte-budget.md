---
"@hyperfly/python": patch
---

The new `max_total_bytes` and `max_byte_amplification` limits cap the decoded bytes of every string and bytes value in one body, including literals, enum members and profile values, so a small body can no longer decode to a huge one.
