from dataclasses import dataclass
from typing import Any

@dataclass(frozen=True)
class ReconstructionRequest:
    evidence_ids: list[str]
    target_representation: str
    constraints: dict[str, Any]

class ReconstructionAdapter:
    adapter_id = "abstract"
    def capabilities(self) -> dict[str, Any]:
        raise NotImplementedError
    def reconstruct(self, request: ReconstructionRequest) -> dict[str, Any]:
        raise NotImplementedError
