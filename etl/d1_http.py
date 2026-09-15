#!/usr/bin/env python3
"""Shared async client for the Cloudflare D1 REST /query endpoint.

Adds what the legacy loaders lacked:

* a GLOBAL token-bucket rate limit (the documented API limit is 1,200
  requests / 5 min per token; a 429 blocks *every* API call for 5 minutes,
  including verification reads), adaptive: halves on 971/429 for 5 minutes;
* retry classification per the plan (rate-limit -> backoff; "statement too
  long"/"too many SQL variables" -> permanent; timeout/5xx/7500 -> bounded
  re-send, which is only safe because every writer statement is idempotent);
* a ledger of ``meta.rows_written`` / ``rows_read`` / ``changes`` /
  ``duration`` per call, split into committed vs failed-attempt rows, so the
  actual bill is known while the run is in progress;
* ids returned as text: callers that read ids MUST select ``CAST(id AS TEXT)``
  because D1 returns INTEGER as a JS Number (exact only <= 2^53-1).

Auth: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from the environment.
"""
from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import aiohttp


class D1PermanentError(RuntimeError):
    pass


class D1RateLimited(RuntimeError):
    pass


_PERMANENT = ("statement too long", "too many sql variables", "too complex", "not authorized",
              "no such table", "no such column", "syntax error", "unique constraint")
_RATE = ("971", "7429", "rate limit", "rate-limit", "too many requests")


@dataclass
class CallMeta:
    rows_written: int = 0
    rows_read: int = 0
    changes: int = 0
    duration_ms: float = 0.0
    size_after: Optional[int] = None


@dataclass
class Ledger:
    committed_rows_written: int = 0
    failed_attempt_rows_written: int = 0
    rows_read: int = 0
    requests: int = 0
    retries: int = 0
    per_db: dict = field(default_factory=dict)

    def add(self, db_id: str, meta: CallMeta, ok: bool) -> None:
        self.requests += 1
        self.rows_read += meta.rows_read
        if ok:
            self.committed_rows_written += meta.rows_written
        else:
            self.failed_attempt_rows_written += meta.rows_written
        d = self.per_db.setdefault(db_id, {"rows_written": 0, "rows_read": 0, "requests": 0})
        d["requests"] += 1
        d["rows_read"] += meta.rows_read
        if ok:
            d["rows_written"] += meta.rows_written

    def snapshot(self) -> dict:
        return {
            "committed_rows_written": self.committed_rows_written,
            "failed_attempt_rows_written": self.failed_attempt_rows_written,
            "rows_read": self.rows_read,
            "requests": self.requests,
            "retries": self.retries,
        }


class TokenBucket:
    def __init__(self, rate_per_s: float, burst: int = 4):
        self.rate = float(rate_per_s)
        self.base_rate = float(rate_per_s)
        self.capacity = burst
        self.tokens = float(burst)
        self.ts = time.monotonic()
        self._lock = asyncio.Lock()
        self._penalty_until = 0.0

    async def take(self) -> None:
        while True:
            async with self._lock:
                now = time.monotonic()
                if now > self._penalty_until and self.rate < self.base_rate:
                    self.rate = self.base_rate
                self.tokens = min(self.capacity, self.tokens + (now - self.ts) * self.rate)
                self.ts = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                wait = (1 - self.tokens) / self.rate
            await asyncio.sleep(wait)

    def penalize(self, seconds: float = 300.0) -> None:
        self.rate = max(0.5, self.rate / 2)
        self._penalty_until = time.monotonic() + seconds


def parse_meta(result: dict) -> CallMeta:
    m = result.get("meta") or {}
    return CallMeta(
        rows_written=int(m.get("rows_written") or 0),
        rows_read=int(m.get("rows_read") or 0),
        changes=int(m.get("changes") or 0),
        duration_ms=float(m.get("duration") or 0.0),
        size_after=m.get("size_after"),
    )


class D1Client:
    def __init__(
        self,
        session: aiohttp.ClientSession,
        account_id: str,
        bucket: TokenBucket,
        ledger: Ledger,
        log=print,
        max_rate_retries: int = 6,
        max_transient_retries: int = 5,
    ):
        self.session = session
        self.account_id = account_id
        self.bucket = bucket
        self.ledger = ledger
        self.log = log
        self.max_rate_retries = max_rate_retries
        self.max_transient_retries = max_transient_retries

    def url(self, db_id: str) -> str:
        base = os.environ.get("D1_API_BASE", "https://api.cloudflare.com")  # test override
        return f"{base}/client/v4/accounts/{self.account_id}/d1/database/{db_id}/query"

    async def query(self, db_id: str, sql: str, params: Optional[list] = None, *, idempotent: bool = True,
                    label: str = "") -> tuple[list[dict], list[CallMeta]]:
        """Run one request (sql may contain several ';'-separated statements).

        Returns (results, metas): one entry per statement.  ``results[i]``
        is the raw D1 result object (``{"results": [...rows], "meta": {...}}``).
        """
        body: dict[str, Any] = {"sql": sql}
        if params:
            body["params"] = params
        rate_attempts = 0
        transient_attempts = 0
        while True:
            await self.bucket.take()
            try:
                async with self.session.post(self.url(db_id), json=body) as r:
                    status = r.status
                    try:
                        data = await r.json()
                    except Exception as e:  # HTML error page etc.
                        text = (await r.text())[:300]
                        raise aiohttp.ContentTypeError(r.request_info, r.history, message=f"{status}: {text}") from e
            except (asyncio.TimeoutError, aiohttp.ClientError) as e:
                transient_attempts += 1
                self.ledger.retries += 1
                if not idempotent or transient_attempts > self.max_transient_retries:
                    raise
                self.log(f"  d1 transient ({label}): {type(e).__name__}: {str(e)[:120]} -> retry {transient_attempts}")
                await asyncio.sleep(10.0)
                continue

            if data.get("success"):
                results = data.get("result") or []
                metas = [parse_meta(x) for x in results]
                for m in metas:
                    self.ledger.add(db_id, m, ok=True)
                return results, metas

            err = str(data.get("errors") or data.get("messages") or data)
            low = err.lower()
            if status == 429 or any(c in low for c in _RATE):
                rate_attempts += 1
                self.ledger.retries += 1
                self.bucket.penalize()
                if rate_attempts > self.max_rate_retries:
                    raise D1RateLimited(err)
                delay = 5.0 * (1.7 ** (rate_attempts - 1))
                self.log(f"  d1 rate-limited ({label}); sleeping {delay:.0f}s")
                await asyncio.sleep(delay)
                continue
            if any(c in low for c in _PERMANENT):
                raise D1PermanentError(err)
            # 7500 / 5xx / unknown: transient, bounded re-send
            transient_attempts += 1
            self.ledger.retries += 1
            # failed attempts may still have metered rows; ledger them separately
            for x in data.get("result") or []:
                self.ledger.add(db_id, parse_meta(x), ok=False)
            if not idempotent or transient_attempts > self.max_transient_retries:
                raise RuntimeError(f"d1 error ({label}): {err}")
            self.log(f"  d1 error ({label}): {err[:160]} -> retry {transient_attempts}")
            await asyncio.sleep(10.0)


def env_auth() -> tuple[str, str]:
    tok = os.environ.get("CLOUDFLARE_API_TOKEN") or os.environ.get("CLOUDFLARE_API_KEY")
    acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not tok or not acct:
        raise SystemExit("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required in the environment")
    return tok, acct


def make_session(token: str, timeout_s: float = 120.0, limit: int = 16) -> aiohttp.ClientSession:
    conn = aiohttp.TCPConnector(limit=limit)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    return aiohttp.ClientSession(connector=conn, headers=headers,
                                 timeout=aiohttp.ClientTimeout(total=timeout_s, connect=15))


def parse_bindings(toml_path) -> dict[str, str]:
    """binding -> database_id from wrangler.toml [[d1_databases]] blocks."""
    out: dict[str, str] = {}
    cur: dict[str, str] = {}
    for line in open(toml_path).read().splitlines():
        line = line.strip()
        if line.startswith("[[d1_databases]]"):
            if cur.get("binding") and cur.get("database_id"):
                out[cur["binding"]] = cur["database_id"]
            cur = {}
        elif "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            cur[k.strip()] = v.strip().strip('"')
    if cur.get("binding") and cur.get("database_id"):
        out[cur["binding"]] = cur["database_id"]
    return out
