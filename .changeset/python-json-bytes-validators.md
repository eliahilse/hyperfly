---
"@hyperfly/python": patch
---

HTTP JSON fallback now encodes declared bytes beneath field validators as standard padded base64, so binary payloads round trip reliably, including non-UTF-8 data. Custom serializers keep their existing output.
