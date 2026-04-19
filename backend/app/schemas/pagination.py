"""Shared pagination envelope for list endpoints.

Offset-based pagination (not cursor-based) is fine at MVP scale:
- Max 10,000 rows per list view with current queries
- Offset is simpler for client-side "page N of M" UI
- Deep pagination isn't a current concern — we'd index hot paths before
  seeing offset-pagination performance issues

Usage in a router:
    @router.get("/items", response_model=PaginatedResponse[ItemResponse])
    async def list_items(
        params: PaginationParams = Depends(),
        ...
    ):
        total = await db.scalar(select(func.count()).select_from(Item))
        result = await db.execute(
            select(Item).order_by(Item.created_at.desc())
            .offset(params.offset).limit(params.page_size)
        )
        items = [ItemResponse.model_validate(i) for i in result.scalars()]
        return PaginatedResponse(
            items=items, total=total, page=params.page, page_size=params.page_size,
        )
"""

from typing import Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel, Field

T = TypeVar("T")


class PaginationParams(BaseModel):
    """Query-string params parsed by FastAPI's `Depends()`.

    Defaults are conservative — 20 items per page so initial paint is fast.
    Clients can request larger pages up to MAX_PAGE_SIZE.
    """
    page: int = Field(default=1, ge=1, description="1-indexed page number")
    page_size: int = Field(default=20, ge=1, le=100, description="Items per page, 1-100")

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


def pagination(
    page: int = Query(default=1, ge=1, description="1-indexed page number"),
    page_size: int = Query(default=20, ge=1, le=100, description="Items per page"),
) -> PaginationParams:
    """FastAPI dependency for pagination query params."""
    return PaginationParams(page=page, page_size=page_size)


class PaginatedResponse(BaseModel, Generic[T]):
    items: list[T]
    total: int = Field(description="Total row count matching the query (ignoring page/page_size)")
    page: int
    page_size: int

    @property
    def total_pages(self) -> int:
        if self.page_size == 0:
            return 0
        return max(1, (self.total + self.page_size - 1) // self.page_size)

    @property
    def has_next(self) -> bool:
        return self.page < self.total_pages

    @property
    def has_prev(self) -> bool:
        return self.page > 1
