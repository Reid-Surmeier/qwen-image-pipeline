# ADR 0009: Route Seedance submission through Conductor

Status: accepted by the owner in Issue #96 and its parent #29.

This supersedes ADR 0008 only where it preserved Seedance's legacy submission path and reference policy. The public `image-pipeline animation --application PATH --objective PATH [--execute]` command now plans and advances application-owned Seedance Runs through Conductor. Its production adapter may submit only after Run Record issues the durable one-use Submission Permit, and every continuation polls the persisted job identity. The retained `seedance-icons submit` entry point always refuses before provider access; retained planning, polling, conformance, and verification utilities remain available for existing run directories.

An authoritative motion video remains the default reference. When none exists, exactly two locked image references named `first-frame` and `last-frame` may be admitted only when both carry the same `inferred-motion/v1:` authority reason. Its JSON record must state non-empty provenance, behavior, timing, spatial permissions, and cancel/restart behavior, plus `historicalFidelity: false`. This is an explicit inference contract, never evidence of historical motion fidelity.

The adapter uses the existing Generation interface and version-1 evidence schemas; no module interface or Run schema changes. Completed bytes still pass independent Video Verification. Application import and human Approval remain downstream. Ordinary CI uses local provider fixtures and performs no paid request. ComfyUI migration remains deferred to #29.
