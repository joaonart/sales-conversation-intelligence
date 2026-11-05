

def test_the_rubric_header_reads_the_prompt_of_the_general_evaluation():
    from sci_bq import queries as q
    from sci_bq.tables import Tables as T
    sql = q.rubric_header(T(project="proj-123456"), pinned=False)
    assert "summary_prompt" in sql and "status = 'PUBLISHED'" in sql  # only published (immutable) rubrics are ever loaded for an analysis
