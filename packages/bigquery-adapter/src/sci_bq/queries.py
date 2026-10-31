"""SQL builders. Every query: explicit columns, tenant predicates, parameters, partition bounds."""
from __future__ import annotations

from sci_bq.tables import Tables

SESSION_COLS = "organization_id, workspace_id, session_id, channel, customer_id, seller_id, status, started_at, updated_at, closed_at"
MESSAGE_COLS = "message_id, session_id, sender_id, sender_type, message_type, content, created_at, sequence_number"
RUBRIC_COLS = "organization_id, workspace_id, rubric_id, version, name, status"
CRITERIA_COLS = (
    "criterion_id, criterion_name, evaluation_instructions, evaluation_type, weight, required, enabled, "
    "applicability_rule, score_mapping, choices, score_levels, display_order"
)
POLICY_COLS = (
    "minimum_approval_score, missing_evidence_policy, max_analyses_per_session, max_input_tokens, monthly_budget_usd, "
    "min_messages, min_customer_messages, min_seller_messages"
)
TENANT = "organization_id = @organization_id AND workspace_id = @workspace_id"


def rubric_header(t: Tables, *, pinned: bool) -> str:
    version = "AND version = @version" if pinned else ""
    return (
        f"SELECT {RUBRIC_COLS} FROM {t.rubrics} "
        f"WHERE {TENANT} AND rubric_id = @rubric_id AND status = 'PUBLISHED' {version} "
        "ORDER BY version DESC LIMIT 1"
    )


def rubric_criteria(t: Tables) -> str:
    return (
        f"SELECT {CRITERIA_COLS} FROM {t.criteria} "
        f"WHERE {TENANT} AND rubric_id = @rubric_id AND rubric_version = @version ORDER BY display_order, criterion_id"
    )


def rubric_policy(t: Tables) -> str:
    return (
        f"SELECT {POLICY_COLS} FROM {t.policies} "
        f"WHERE {TENANT} AND rubric_id = @rubric_id AND rubric_version = @version LIMIT 1"
    )


def session_page(t: Tables, *, only_status: bool, only_routed: bool = False) -> str:
    """Keyset page ordered by (updated_at, session_id); `started_at` bounds prune partitions.

    `only_routed` keeps the sessions whose current routing decision points to @route_rubric (tenant-scoped subquery)."""
    status = "AND status = @status" if only_status else ""
    routed = (
        f"AND session_id IN (SELECT session_id FROM {t.current_routes} WHERE {TENANT} AND rubric_id = @route_rubric "
        "AND (rubric_version IS NULL OR rubric_version = @route_version)) "
    ) if only_routed else ""
    return (
        f"SELECT {SESSION_COLS} FROM {t.sessions} "
        f"WHERE {TENANT} AND DATE(started_at) BETWEEN @start_date AND @end_date {status} {routed}"
        "AND (updated_at > @cursor_updated_at OR (updated_at = @cursor_updated_at AND session_id > @cursor_session_id)) "
        "ORDER BY updated_at, session_id LIMIT @page_size"
    )


def session_by_id(t: Tables) -> str:
    return (
        f"SELECT {SESSION_COLS} FROM {t.sessions} "
        f"WHERE {TENANT} AND session_id = @session_id AND DATE(started_at) >= @since_date "
        "ORDER BY updated_at DESC LIMIT 1"
    )


def messages_for_sessions(t: Tables) -> str:
    """One grouped fetch for many sessions (never one query per session)."""
    return (
        f"SELECT {MESSAGE_COLS} FROM {t.messages} "
        f"WHERE {TENANT} AND session_id IN UNNEST(@session_ids) "
        "AND DATE(created_at) BETWEEN @start_date AND @end_date "
        "ORDER BY session_id, sequence_number, message_id"
    )


def existing_analyses(t: Tables) -> str:
    """Already-analysed (session, content hash) pairs for a rubric version produced by one model + prompt version; bounded by started_at."""
    return (
        f"SELECT DISTINCT session_id, session_content_hash FROM {t.analyses} "
        f"WHERE {TENANT} AND rubric_id = @rubric_id AND rubric_version = @version AND model = @model AND prompt_version = @prompt_version "
        "AND DATE(started_at) >= @since_date AND analysis_status != 'FAILED' AND session_id IN UNNEST(@session_ids)"
    )


def latest_run(t: Tables) -> str:
    return (
        "SELECT run_id, run_status, sessions_total, sessions_processed, sessions_failed, sessions_skipped, "
        f"estimated_cost_usd, actual_cost_usd, checkpoint, created_at, finished_at FROM {t.runs} "
        f"WHERE {TENANT} AND run_id = @run_id AND DATE(created_at) >= @since_date "
        "ORDER BY created_at DESC LIMIT 1"
    )


def month_to_date_spend(t: Tables) -> str:
    """Analyses plus routing decisions: the monthly budget covers everything paid to the provider."""
    return (
        "SELECT "
        f"COALESCE((SELECT SUM(estimated_cost_usd) FROM {t.analyses} WHERE {TENANT} AND DATE(started_at) >= @month_start), 0) + "
        f"COALESCE((SELECT SUM(estimated_cost_usd) FROM {t.routes} WHERE {TENANT} AND DATE(decided_at) >= @month_start), 0) AS spent_usd"
    )


def recent_analysis_count(t: Tables) -> str:
    return (
        f"SELECT COUNT(1) AS n FROM {t.analyses} "
        f"WHERE {TENANT} AND session_id = @session_id AND rubric_id = @rubric_id AND rubric_version = @version "
        "AND DATE(started_at) >= @since_date AND started_at >= @since_ts AND analysis_status != 'FAILED'"
    )


def existing_routes(t: Tables) -> str:
    """Already-routed (session, content hash) pairs for one router identity (model + prompt + route definitions)."""
    return (
        f"SELECT DISTINCT session_id, session_content_hash FROM {t.routes} "
        f"WHERE {TENANT} AND model = @model AND prompt_version = @prompt_version "
        "AND DATE(decided_at) >= @since_date AND session_id IN UNNEST(@session_ids)"
    )


def route_for_session(t: Tables) -> str:
    """The decision already taken for this exact content under one router identity (live: avoids classifying twice)."""
    return (
        f"SELECT route_key, rubric_id, rubric_version, route_state FROM {t.routes} "
        f"WHERE {TENANT} AND session_id = @session_id AND session_content_hash = @content_hash "
        "AND model = @model AND prompt_version = @prompt_version AND DATE(decided_at) >= @since_date "
        "ORDER BY decided_at DESC LIMIT 1"
    )
