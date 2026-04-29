"""Compatibility helpers for Pydantic v1 and v2.

The main development/runtime stack uses Pydantic v2. The Windows 7 legacy
installer uses Python 3.7.9 + Pydantic v1 to avoid Rust-backed pydantic-core and
newer Windows loader APIs that are unavailable on base Win7.
"""
from __future__ import annotations

from typing import Any, Type, TypeVar

try:  # Pydantic v2
    from pydantic import field_validator as _field_validator

    PYDANTIC_V2 = True
except ImportError:  # Pydantic v1
    from pydantic import validator as _validator

    PYDANTIC_V2 = False

ModelT = TypeVar("ModelT")


def field_validator(*fields: str, mode: str = "after", **kwargs: Any):
    """Map Pydantic v2's `field_validator` API to Pydantic v1 validators."""
    if PYDANTIC_V2:
        return _field_validator(*fields, mode=mode, **kwargs)

    pre = mode == "before"

    def decorator(func):
        if isinstance(func, classmethod):
            func = func.__func__
        return _validator(*fields, pre=pre, allow_reuse=True)(func)

    return decorator


def model_validate(model_cls: Type[ModelT], payload: Any) -> ModelT:
    """Create `model_cls` from payload under Pydantic v1 or v2."""
    validate = getattr(model_cls, "model_validate", None)
    if validate is not None:
        return validate(payload)

    if isinstance(payload, model_cls):
        return payload
    if isinstance(payload, dict):
        return model_cls(**payload)
    if hasattr(payload, "dict"):
        return model_cls(**payload.dict())
    return model_cls.from_orm(payload)


def model_dump(model: Any, **kwargs: Any) -> dict:
    """Dump a Pydantic/SQLModel instance under Pydantic v1 or v2."""
    dump = getattr(model, "model_dump", None)
    if dump is not None:
        return dump(**kwargs)
    return model.dict(**kwargs)


def model_rebuild(model_cls: Type[Any]) -> None:
    """Resolve forward references under Pydantic v1 or v2."""
    rebuild = getattr(model_cls, "model_rebuild", None)
    if rebuild is not None:
        rebuild()
        return

    update_forward_refs = getattr(model_cls, "update_forward_refs", None)
    if update_forward_refs is not None:
        update_forward_refs()
