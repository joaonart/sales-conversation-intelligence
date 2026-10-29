"""Deterministic, realistic synthetic sales conversations (pt-BR) with a hidden ground truth. Offline, free, no AI involved."""

from .generator import DEFAULT_TENANTS, GENERATOR_VERSION, NOW, TenantSpec, generate, generate_tenant

__all__ = ["DEFAULT_TENANTS", "GENERATOR_VERSION", "NOW", "TenantSpec", "generate", "generate_tenant"]
