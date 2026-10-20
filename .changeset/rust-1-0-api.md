---
"@hyperfly/rust": major
---
`Codec::compile` takes a `CompileOptions` value, errors are read through `Error::code()` and `Error::message()`, and option structs and enums are `#[non_exhaustive]` so 1.x can extend them without breaking callers.
