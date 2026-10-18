"""PR #12 follow-up: research latency/retries, native citations, paid-call economy
and official FIRMS reference answers. Mocked transports only; no paid calls."""

import json
from time import perf_counter
from types import SimpleNamespace

import httpx
import openai
import pytest
from openai.types.responses import Response

from app.errors import APIError
from app.schemas.chat import ChatRequest
from app.services.chat_reference import definition_only
from app.services.chat_research import research, verified_url
from app.services.chat_service import ChatService
from app.services.chat_tools import mentioned_locations
from app.services.openai_client import TRACE, ChatTrace, ResponsesClient
from tests.unit.test_chat import (
    NOW,
    PLACE,
    SOURCE_URL,
    MockResponses,
    final,
    mock_http,
    model_response,
    request,
    run,
    service,
    setup,  # noqa: F401 - pytest fixture
)

WEB_TOOL = [{"type": "web_search"}]


# ---- Research latency, retry and observability ------------------------------------


def client_attempts(setup, handler, **kwargs):  # noqa: F811
    attempts = []

    async def counted(req):
        attempts.append(json.loads(req.content))
        return await handler(req, len(attempts))

    async def scenario():
        wrapper = ResponsesClient(setup[0].state.settings, http_client=mock_http(counted))
        try:
            return await wrapper.create(input="California wildfire", **kwargs)
        finally:
            await wrapper.close()

    try:
        return run(scenario()), attempts
    except APIError as error:
        return error, attempts


def test_timed_out_research_is_not_repeated(setup):  # noqa: F811
    # Root cause of the measured 50 s research stage: a 25 s attempt timeout,
    # then a complete repeat of the hosted research.
    async def handler(req, attempt):
        raise httpx.ReadTimeout("fixture timeout", request=req)

    error, attempts = client_attempts(setup, handler, tools=WEB_TOOL)
    assert error.code == "chat_provider_timeout" and len(attempts) == 1


def test_transient_research_failure_still_gets_its_one_retry(setup):  # noqa: F811
    async def handler(req, attempt):
        if attempt == 1:
            return httpx.Response(503, headers={"retry-after-ms": "1"}, json={"error": {}})
        return httpx.Response(200, json=final().model_dump(mode="json"))

    response, attempts = client_attempts(setup, handler, tools=WEB_TOOL)
    assert response.status == "completed" and len(attempts) == 2


@pytest.mark.parametrize(
    "status,headers,body",
    [
        (429, {}, {"error": {"code": "insufficient_quota", "message": "fixture"}}),
        (503, {"retry-after": "30"}, {"error": {"message": "fixture"}}),
        (400, {}, {"error": {"message": "fixture"}}),
    ],
)
def test_quota_long_backoff_and_invalid_requests_are_not_retried(
    setup,  # noqa: F811
    status,
    headers,
    body,
):
    async def handler(req, attempt):
        return httpx.Response(status, headers=headers, json=body)

    error, attempts = client_attempts(setup, handler)
    assert isinstance(error, APIError) and len(attempts) == 1


def test_research_and_synthesis_use_separate_attempt_timeouts(setup):  # noqa: F811
    seen = []

    async def create(**kwargs):
        seen.append(kwargs["timeout"])
        return final()

    wrapper = ResponsesClient(setup[0].state.settings)
    wrapper.client = SimpleNamespace(responses=SimpleNamespace(create=create))
    run(wrapper.create(input="California wildfire", tools=WEB_TOOL))
    run(wrapper.create(input="California wildfire"))
    assert seen == [45, 25]


def test_request_deadline_bounds_attempts_and_prevents_late_retries(setup):  # noqa: F811
    calls = []

    async def create(**kwargs):
        calls.append(kwargs["timeout"])
        raise openai.InternalServerError(
            "fixture",
            response=httpx.Response(
                503, request=httpx.Request("POST", "https://api.openai.com/v1/responses")
            ),
            body=None,
        )

    async def scenario(seconds):
        token = TRACE.set(ChatTrace(deadline=perf_counter() + seconds))
        try:
            wrapper = ResponsesClient(setup[0].state.settings)
            wrapper.client = SimpleNamespace(responses=SimpleNamespace(create=create))
            with pytest.raises(APIError) as error:
                await wrapper.create(input="California wildfire", tools=WEB_TOOL)
            return error.value.code
        finally:
            TRACE.reset(token)

    # Too little time left: no paid attempt starts at all.
    assert run(scenario(3)) == "chat_provider_timeout" and calls == []
    # The attempt timeout is capped by the deadline; a retry that cannot finish is skipped.
    assert run(scenario(5.4)) == "chat_provider_unavailable"
    assert len(calls) == 1 and calls[0] <= 5.4


def test_attempt_and_request_logs_are_timing_only(setup, caplog):  # noqa: F811
    async def handler(req):
        return httpx.Response(200, json=final().model_dump(mode="json"))

    app, _ = setup
    instance = ChatService(
        app.state, ResponsesClient(app.state.settings, http_client=mock_http(handler)), lambda: NOW
    )
    with caplog.at_level("INFO", logger="firewatch.chat"):
        run(instance.answer(request("Weather in Stockton secret-question-marker")))
    logs = "\n".join(record.getMessage() for record in caplog.records)
    assert "chat_model_attempt stage=synthesis attempt=1 outcome=completed" in logs
    assert "chat_request_summary result=openai" in logs and "model_attempts=1" in logs
    assert "secret-question-marker" not in logs and "test-key-fixture-only" not in logs
    assert "api.openai.com" not in logs


# ---- Native research action/citation combinations ---------------------------------

OPENED = "https://www.fire.ca.gov/incidents/"
SEARCH = {"type": "search", "query": "fire", "sources": [{"type": "url", "url": SOURCE_URL}]}


def research_response(actions, citations, text="Official wildfire information."):
    """Arbitrary web_search_call actions and url_citation annotations."""
    output = [
        {"type": "web_search_call", "id": f"ws_{i}", "status": status, "action": action}
        for i, (status, action) in enumerate(actions)
    ]
    message = {
        "type": "message",
        "id": "msg_1",
        "role": "assistant",
        "status": "completed",
        "content": [
            {
                "type": "output_text",
                "text": text,
                "annotations": [
                    {
                        "type": "url_citation",
                        "url": url,
                        "title": "Official page",
                        "start_index": 0,
                        "end_index": 8,
                    }
                    for url in citations
                ],
            }
        ],
    }
    return Response.model_validate(
        {
            "id": "resp_research",
            "created_at": 1,
            "model": "gpt-5-mini",
            "object": "response",
            "status": "completed",
            "output": output + [message],
            "parallel_tool_calls": False,
            "tool_choice": "required",
            "tools": [],
        }
    )


@pytest.mark.parametrize(
    "actions,citations,count,partial",
    [
        # Multiple completed searches; duplicate citations collapse to one source.
        ([("completed", SEARCH), ("completed", SEARCH)], [SOURCE_URL, SOURCE_URL], 1, False),
        # A page the model opened (absent from search sources) is real retrieval.
        (
            [("completed", SEARCH), ("completed", {"type": "open_page", "url": OPENED})],
            [OPENED, SOURCE_URL],
            2,
            False,
        ),
        (
            [("completed", {"type": "find_in_page", "url": OPENED, "pattern": "updates"})],
            [OPENED],
            1,
            False,
        ),
        # Completed + failed / unfinished actions: only completed ones substantiate.
        ([("failed", SEARCH), ("completed", SEARCH)], [SOURCE_URL], 1, True),
        ([("completed", SEARCH), ("in_progress", SEARCH)], [SOURCE_URL], 1, True),
        # Provider tracking parameters do not make a retrieved page unverified.
        ([("completed", SEARCH)], [SOURCE_URL + "?utm_source=openai"], 1, False),
    ],
)
def test_research_accepts_completed_retrievals(actions, citations, count, partial):
    response = research_response(actions, citations)
    result = run(research(MockResponses(response), "Official California fire updates", NOW))
    assert len(result["sources"]) == count and result["partial_retrieval"] is partial
    assert all("utm_" not in source["url"] for source in result["sources"])


def test_research_message_before_actions_is_still_validated():
    response = research_response([("completed", SEARCH)], [SOURCE_URL])
    response.output.reverse()
    result = run(research(MockResponses(response), "Official California fire updates", NOW))
    assert result["sources"][0]["url"] == SOURCE_URL


def test_research_text_links_use_the_registered_clean_url():
    tracked = SOURCE_URL + "?utm_source=openai"
    response = research_response(
        [("completed", SEARCH)], [tracked], text=f"See [CAL FIRE]({tracked})."
    )
    result = run(research(MockResponses(response), "Official California fire updates", NOW))
    assert tracked not in result["summary"] and SOURCE_URL in result["summary"]


@pytest.mark.parametrize(
    "actions,citations,code",
    [
        # Only failed retrievals: nothing can be cited.
        ([("failed", SEARCH)], [SOURCE_URL], "research_unavailable"),
        # A page "opened" by a failed action is not retrieval evidence.
        (
            [("completed", SEARCH), ("failed", {"type": "open_page", "url": OPENED})],
            [OPENED],
            "research_citation_invalid",
        ),
        # A citation to a URL no completed action retrieved (model-written URL).
        ([("completed", SEARCH)], ["https://www.fire.ca.gov/made-up"], "research_citation_invalid"),
        # Retrieved, but a lookalike host outside the official allowlist.
        (
            [
                (
                    "completed",
                    {
                        "type": "search",
                        "sources": [{"type": "url", "url": "https://fire.ca.gov.evil.test/"}],
                    },
                )
            ],
            ["https://fire.ca.gov.evil.test/"],
            "research_citation_invalid",
        ),
        # A completed search without any native citation annotation proves nothing.
        ([("completed", SEARCH)], [], "research_no_sources"),
    ],
)
def test_research_rejects_unsubstantiated_citations(actions, citations, code):
    response = research_response(actions, citations)
    with pytest.raises(APIError) as error:
        run(research(MockResponses(response), "Official California fire updates", NOW))
    assert error.value.code == code


def test_finalize_rejects_unregistered_url_even_with_tracking_parameters(setup):  # noqa: F811
    instance, _, _ = service(
        setup, final("See https://www.fire.ca.gov/other?utm_source=openai [fw-1]")
    )
    with pytest.raises(APIError) as error:
        run(instance.answer(request()))
    assert error.value.code == "chat_citation_invalid"


def test_official_url_containing_risk_assessment_is_not_a_secret(setup):  # noqa: F811
    # Live regression: "...chapter-4-risk-assessment-pdf.pdf" matched an unbounded
    # sk- key pattern, rejecting a valid natively cited research answer.
    pdf = "https://www.fire.ca.gov/media/plan-chapter-4-risk-assessment-pdf.pdf"
    action = {"type": "search", "sources": [{"type": "url", "url": pdf}]}
    response = research_response(
        [("completed", action)], [pdf], text=f"Wind drives fire spread ([plan]({pdf}))."
    )
    instance, client, _ = service(setup, response)
    result = run(instance.answer(request("How does wind affect wildfire spread?")))
    assert len(client.calls) == 1 and pdf in result.answer


def test_local_clock_times_must_equal_a_cited_timestamp():
    from app.services.chat_service import local_time_claims

    # 2026-10-17T22:00Z is 15:00 PDT; 2026-12-17T22:00Z is 14:00 PST.
    evidence = '{"forecast_hour": "2026-10-17T22:00:00Z", "w": "2026-12-17T22:00:00Z"}'
    for text in [
        "Tomorrow afternoon (2026-10-17 15:00 PDT) it is 20 C.",
        "At 3:00 PM PDT it is 20 C.",
        "At 3:00 p.m. PT it is 20 C.",
        "Winter sample: 2026-12-17 14:00 PST.",
    ]:
        assert "PDT" not in local_time_claims(text, evidence)
        assert "PST" not in local_time_claims(text, evidence)
    # Wrong hour, wrong date, or a fetch-free invented time all fail closed, even
    # when the digits occur elsewhere in the evidence.
    for text in ["At 2026-10-17 17:00 PDT", "At 2026-10-18 15:00 PDT", "At 10:22 PDT"]:
        with pytest.raises(APIError) as error:
            local_time_claims(text, evidence)
        assert error.value.code == "chat_fact_unverified"


def test_live_weather_answer_with_local_forecast_time_is_accepted(setup):  # noqa: F811
    # Live regression: "Tomorrow afternoon (2026-10-18 15:00 PDT) ..." returned 502
    # because only the UTC forecast hour (22:00Z) was numeric evidence.
    hour = NOW.replace(hour=22)
    instance, _, _ = service(
        setup, final("Tomorrow afternoon (2026-10-17 15:00 PDT) it is 20 C (68 F). [fw-1]")
    )
    result = run(
        instance.answer(
            ChatRequest(message="Weather in Stockton", location_id=PLACE, selected_hour=hour)
        )
    )
    assert "15:00 PDT" in result.answer
    wrong = service(setup, final("At 2026-10-17 16:00 PDT it is 20 C. [fw-1]"))[0]
    with pytest.raises(APIError) as error:
        run(
            wrong.answer(
                ChatRequest(message="Weather in Stockton", location_id=PLACE, selected_hour=hour)
            )
        )
    assert error.value.code == "chat_fact_unverified"


@pytest.mark.parametrize(
    "token", ["sk-proj-" + "Ab3_" * 10, "sk-" + "x9" * 24, "BEGIN RSA PRIVATE KEY"]
)
def test_key_shaped_tokens_are_still_rejected(setup, token):  # noqa: F811
    instance, _, _ = service(setup, final(f"Forecast temperature is 20 C {token}. [fw-1]"))
    with pytest.raises(APIError) as error:
        run(instance.answer(request()))
    assert error.value.code == "chat_output_rejected"


# ---- Orchestration: no redundant or wasted paid calls -------------------------------


def test_direct_research_answer_falls_back_to_synthesis_if_invalid(setup):  # noqa: F811
    instance, client, _ = service(
        setup,
        model_response("Wind drives spread. I can retrieve satellite imagery for you.", web=True),
        final("Wind can drive rapid wildfire spread. [research-1-web-1]", ["research-1-web-1"]),
    )
    result = run(instance.answer(request("How does wind affect wildfire spread?")))
    assert len(client.calls) == 2 and "imagery" not in result.answer
    assert "rapid wildfire spread" in result.answer


def test_direct_research_drops_trailing_offer_paragraphs_only(setup):  # noqa: F811
    # Live: research answers ended with "If you want, I can ..." despite instructions.
    text = (
        "Sign up for county alerts and pack a go-bag.\n\n"
        "If you want, tell me your county and I'll point to its pages.\n\n"
        "Would you like a printable checklist?"
    )
    instance, client, _ = service(setup, model_response(text, web=True))
    result = run(instance.answer(request("How should I prepare for wildfire evacuation?")))
    assert "go-bag" in result.answer and "If you want" not in result.answer
    assert "Would you like" not in result.answer and SOURCE_URL in result.answer
    assert len(client.calls) == 1


def test_failed_research_returns_server_notice_without_paid_synthesis(setup):  # noqa: F811
    instance, client, _ = service(setup, APIError("chat_provider_timeout", "timeout", 504))
    result = run(instance.answer(request("How does wind affect wildfire spread?")))
    assert len(client.calls) == 1 and result.mode == "data_unavailable" and result.model is None
    assert "Authoritative online research is unavailable" in result.answer
    assert any("chat_provider_timeout" in item for item in result.limitations)


def test_current_order_question_still_uses_local_authorities_only(setup):  # noqa: F811
    instance, client, _ = service(setup, model_response("Official source", web=True))
    result = run(instance.answer(request("Is there an active evacuation order in Stockton?")))
    domains = client.calls[0]["tools"][0]["filters"]["allowed_domains"]
    assert "sjready.org" in domains and "ready.gov" not in domains
    assert "cannot verify current evacuation orders" in result.answer and len(client.calls) == 1


def test_local_wind_forecast_question_still_uses_firewatch_weather(setup):  # noqa: F811
    instance, client, provider = service(setup, final("Wind is 10 km/h. [fw-1]"))
    result = run(instance.answer(request("What is the wind forecast in Stockton tomorrow?")))
    assert result.tools_used == ["get_wind"] and provider.calls == 1
    assert "web_search" not in json.dumps(client.calls[0]["tools"])


def test_descriptive_imagery_is_science_not_an_unsupported_offer(setup):  # noqa: F811
    instance, _, _ = service(
        setup, final("Satellite imagery helps detect fires; forecast is 20 C. [fw-1]")
    )
    assert "imagery" in run(instance.answer(request())).answer


@pytest.mark.parametrize(
    "promise",
    ["Try a radius search near Stockton.", "Do you want satellite images of the area?"],
)
def test_imperative_and_question_offers_still_fail_closed(setup, promise):  # noqa: F811
    instance, _, _ = service(setup, final("Forecast temperature is 20 C. [fw-1] " + promise))
    with pytest.raises(APIError) as error:
        run(instance.answer(request()))
    assert error.value.code == "chat_capability_unavailable"


def test_unavailable_prediction_notice_names_the_actual_area(setup):  # noqa: F811
    instance, client, _ = service(setup)
    result = run(instance.answer(request("What is Stockton's risk over the next seven days?")))
    assert result.mode == "data_unavailable" and client.calls == []
    assert "unavailable for Stockton" in result.answer
    unscoped = run(
        instance.answer(ChatRequest(message="What is the wildfire risk?", selected_hour=NOW))
    )
    assert "unavailable for California" in unscoped.answer


# ---- Official FIRMS reference definitions ------------------------------------------


@pytest.mark.parametrize(
    "question,required,source",
    [
        (
            "What does fire radiative power mean?",
            ["megawatts (MW)", "not acreage", "probability of fire", "proxy of fire intensity"],
            "ref-firms-viirs",
        ),
        ("What is FRP?", ["megawatts (MW)"], "ref-firms-faq"),
        (
            "What does nominal confidence mean for this VIIRS detection?",
            ["nominal (n)", "does not mean low", "not numeric probabilities", ">15 K"],
            "ref-firms-viirs",
        ),
        (
            "What is the difference between a satellite hotspot and a confirmed wildfire?",
            ["not a confirmed wildfire", "375 m", "official incident reports", "gas-well flares"],
            "ref-firms-faq",
        ),
    ],
)
def test_firms_definitions_are_official_reference_answers_without_model(
    setup,  # noqa: F811
    question,
    required,
    source,
):
    instance, client, provider = service(setup)
    result = run(instance.answer(request(question)))
    assert result.mode == "reference" and result.model is None
    assert client.calls == [] and provider.calls == 0
    assert result.tools_used == ["firewatch_reference"]
    assert all(text in result.answer for text in required), result.answer
    refs = {row.id: row for row in result.sources}
    assert refs[source].kind == "reference" and refs[source].url in result.answer
    assert all(verified_url(row.url) for row in refs.values())
    assert "not fetched live" in refs[source].freshness


@pytest.mark.parametrize(
    "question",
    [
        "What is the FRP of the latest detections near Sacramento?",
        "Show recent hotspots and what their confidence means",
        "Is the FRP elevated today?",
        "What does low confidence mean for wildfire risk?",
    ],
)
def test_data_requests_about_firms_fields_are_not_definition_only(setup, question):  # noqa: F811
    mentioned = mentioned_locations(setup[0].state.locations, question)
    assert not definition_only(question, mentioned)


def test_detection_answer_receives_official_confidence_definition(setup):  # noqa: F811
    from tests.integration.test_fires import Provider, observation

    app, _ = setup
    run(app.state.fires.refresh(now=NOW, client=Provider([observation()])))
    instance, client, _ = service(
        setup,
        final(
            "Detections use nominal (n) confidence, not low. [fw-1] [ref-firms-viirs]",
            ["fw-1", "ref-firms-viirs"],
        ),
    )
    result = run(
        instance.answer(
            ChatRequest(
                message="What do the confidence values of recent satellite detections mean?",
                selected_hour=NOW,
            )
        )
    )
    payload = json.loads(client.calls[0]["input"][0]["content"])
    topics = [row.get("topic") for row in payload["server_context"]["actual_firewatch_results"]]
    assert "confidence" in topics and result.tools_used[0] == "get_detections"
    assert "firms.modaps.eosdis.nasa.gov" in result.answer
