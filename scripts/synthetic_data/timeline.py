"""Human-looking timestamps: business-hour skew, weekday seasonality, reply latencies with heavy tails, conversations resumed next day."""

from __future__ import annotations

import math
import random
from datetime import UTC, datetime, timedelta

LOCAL_OFFSET = timedelta(hours=3)  # America/Sao_Paulo is UTC-3 (no DST): UTC = local + 3h
WEEKDAY_WEIGHT = [1.0, 1.05, 1.0, 1.0, 0.95, 0.55, 0.35]  # Mon..Sun
HOUR_WEIGHT = {8: 3, 9: 6, 10: 9, 11: 9, 12: 6, 13: 5, 14: 8, 15: 9, 16: 9, 17: 8, 18: 7, 19: 6, 20: 6, 21: 4, 22: 2, 23: 1, 7: 1}


def pick_start(rng: random.Random, now: datetime, days: int, *, evening_bias: float = 0.0) -> datetime:
    """Local-time start with weekday/hour weights; returned in UTC. Later days are a bit busier (growth)."""
    while True:
        back = int(rng.random() ** 1.25 * days) + 1  # more recent days are more likely
        day = (now - timedelta(days=back)).replace(hour=0, minute=0, second=0, microsecond=0)
        if rng.random() > WEEKDAY_WEIGHT[day.weekday()]:
            continue
        hours = list(HOUR_WEIGHT)
        weights = [HOUR_WEIGHT[h] * (1 + evening_bias * (h >= 18)) for h in hours]
        hour = rng.choices(hours, weights)[0]
        local = day + timedelta(hours=hour, minutes=rng.randint(0, 59), seconds=rng.randint(0, 59))
        return local + LOCAL_OFFSET


def _lognormal(rng: random.Random, median: float, sigma: float) -> float:
    return math.exp(math.log(median) + sigma * rng.gauss(0, 1))


def next_time(rng: random.Random, prev: datetime, *, who: str, same_sender: bool, resume_prob: float) -> datetime:
    """Time of the next message after `prev` (UTC)."""
    if same_sender:
        delta = rng.uniform(2, 14)  # a burst of consecutive messages
    elif who == "customer":
        delta = _lognormal(rng, 55, 1.1)  # customers think and multitask
    elif who == "seller":
        delta = _lognormal(rng, 40, 0.8)
    else:
        delta = rng.uniform(1, 6)  # bot and system reply immediately
    t = prev + timedelta(seconds=delta)
    if who == "customer" and not same_sender and rng.random() < resume_prob:
        t += timedelta(hours=rng.uniform(4, 30))  # the customer comes back later or the next day
    if who == "seller":
        local = t - LOCAL_OFFSET
        if local.hour >= 21 or local.hour < 8:  # sellers answer in business hours
            nxt = local.replace(hour=8, minute=rng.randint(0, 25), second=rng.randint(0, 59))
            if local.hour >= 21:
                nxt += timedelta(days=1)
            t = nxt + LOCAL_OFFSET
    return t.astimezone(UTC) if t.tzinfo else t.replace(tzinfo=UTC)
