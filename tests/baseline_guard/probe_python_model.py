try:
    import torch  # type: ignore[import-not-found]  # pragma: no cover
except ImportError as error:
    if "model inference is disabled" not in str(error):
        raise
    print("model inference is disabled in the deterministic baseline")
else:
    raise SystemExit("model import escaped the deterministic baseline")
