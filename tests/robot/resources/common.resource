*** Settings ***
Documentation     Shared keywords for the SweepDeck core CLI acceptance suites.
...
...               ${CLI_PATH} defaults to the in-repo build and is overridable:
...               robot --variable CLI_PATH:/abs/path/to/cli.js tests/robot
Library           Process
Library           OperatingSystem
Library           Collections
Library           String
Library           ${CURDIR}${/}helpers.py

*** Variables ***
${CLI_PATH}       ${CURDIR}${/}..${/}..${/}..${/}packages${/}core${/}dist${/}cli.js
${FIXTURE_SCRIPT}    ${CURDIR}${/}..${/}..${/}..${/}scripts${/}make-fixtures.mjs
${NODE}           node
${LARGE_THRESHOLD}    1000000
${QUARANTINE_NAME}    .sweepdeck-quarantine

*** Keywords ***
Require Cli Build
    [Documentation]    Fails fast with a clear message when the CLI is not built.
    File Should Exist    ${CLI_PATH}    CLI not found at ${CLI_PATH} — build packages/core or pass --variable CLI_PATH:<abs path>

Build Fixture Sandbox
    [Documentation]    Creates a temp dir and populates it via scripts/make-fixtures.mjs.
    ${sandbox}=    Make Temp Dir    sweepdeck-fixture-
    ${result}=    Run Process    ${NODE}    ${FIXTURE_SCRIPT}    ${sandbox}    timeout=120 s    on_timeout=kill
    Should Be Equal As Integers    ${result.rc}    0    fixture build failed: ${result.stderr}
    RETURN    ${sandbox}

Make Temp Db
    [Documentation]    A graph.db path in its own temp dir, OUTSIDE any sandbox tree.
    ${dir}=    Make Temp Dir    sweepdeck-db-
    ${db}=    Join Path    ${dir}    graph.db
    RETURN    ${db}

Run Core Cli
    [Documentation]    Runs the CLI via the node executable from PATH; returns the Process result.
    ...    Pass timeout=<time> (named-only) to shorten the kill timeout for
    ...    commands known to hang (see BUGS.md BUG-002).
    [Arguments]    @{args}    ${timeout}=180 s
    ${result}=    Run Process    ${NODE}    ${CLI_PATH}    @{args}    timeout=${timeout}    on_timeout=kill
    RETURN    ${result}

Run Sandbox Scan
    [Documentation]    scan --json against a sandbox root; returns the Process result (rc asserted 0).
    [Arguments]    ${sandbox}    ${db}    ${categories}=junk,large,duplicate
    ${result}=    Run Core Cli    scan    --categories    ${categories}    --root    ${sandbox}
    ...    --db    ${db}    --large-threshold    ${LARGE_THRESHOLD}    --json
    Should Be Equal As Integers    ${result.rc}    0    scan failed: ${result.stderr}
    RETURN    ${result}

Get Plan
    [Documentation]    plan --run <runId> --json parsed into a CleanPlan dict.
    [Arguments]    ${run_id}    ${db}
    ${result}=    Run Core Cli    plan    --run    ${run_id}    --db    ${db}    --json
    Should Be Equal As Integers    ${result.rc}    0    plan failed: ${result.stderr}
    ${plan}=    Evaluate    json.loads($result.stdout)    json
    RETURN    ${plan}

Parse JSONL Events
    [Documentation]    Parses scan stdout into the list of WorkflowEvent dicts (summary line excluded).
    [Arguments]    ${stdout}
    ${events}=    Get Workflow Events    ${stdout}
    RETURN    ${events}

Get Summary From Scan Output
    [Documentation]    The ScanSummary dict from the final {"type":"summary"} line.
    [Arguments]    ${stdout}
    ${summary}=    Get Scan Summary    ${stdout}
    RETURN    ${summary}

Cleanup Sandbox
    [Arguments]    ${path}
    Run Keyword If    $path    Remove Directory    ${path}    recursive=True

Quarantine Dir Of
    [Arguments]    ${sandbox}
    ${dir}=    Join Path    ${sandbox}    ${QUARANTINE_NAME}
    RETURN    ${dir}
