*** Settings ***
Documentation     CLI contract — JSONL event stream shape, summary line, and the
...               read-only real-mode commands (disk status, procs list).
Resource          resources${/}common.resource
Suite Setup       Contract Suite Setup
Suite Teardown    Contract Suite Teardown
Test Tags         contract

*** Variables ***
${SANDBOX}        ${EMPTY}
${DB}             ${EMPTY}
${SCAN_STDOUT}    ${EMPTY}

*** Test Cases ***
Scan Json Emits Parseable JSONL
    [Documentation]    Every stdout line of scan --json must parse as a JSON document.
    ${docs}=    Parse Jsonl    ${SCAN_STDOUT}
    ${count}=    Get Length    ${docs}
    Should Be True    ${count} > 5    expected a JSONL event stream, got ${count} lines

Event Stream Contains Run And Gate Lifecycle
    ${events}=    Parse JSONL Events    ${SCAN_STDOUT}
    ${types}=    Evaluate    [e['type'] for e in $events]
    List Should Contain Value    ${types}    run_started
    List Should Contain Value    ${types}    gate_waiting
    List Should Contain Value    ${types}    run_finished
    FOR    ${ev}    IN    @{events}
        Dictionary Should Contain Key    ${ev}    ts
        Dictionary Should Contain Key    ${ev}    runId
        Dictionary Should Contain Key    ${ev}    phase
        Dictionary Should Contain Key    ${ev}    node
        Dictionary Should Contain Key    ${ev}    data
    END

Event Stream Contains Scan Verify And Merge Phases
    ${events}=    Parse JSONL Events    ${SCAN_STDOUT}
    FOR    ${phase}    IN    scan    verify    merge
        ${started}=    Evaluate    [e for e in $events if e['phase'] == '${phase}' and e['type'] == 'phase_started']
        ${finished}=    Evaluate    [e for e in $events if e['phase'] == '${phase}' and e['type'] == 'phase_finished']
        Should Not Be Empty    ${started}    missing phase_started for phase '${phase}'
        Should Not Be Empty    ${finished}    missing phase_finished for phase '${phase}'
    END

Final Summary Line Carries Run Plan And Candidates
    ${summary}=    Get Summary From Scan Output    ${SCAN_STDOUT}
    ${events}=    Parse JSONL Events    ${SCAN_STDOUT}
    Should Not Be Empty    ${summary['runId']}
    Should Be Equal    ${summary['runId']}    ${events[0]['runId']}    summary runId differs from the event stream runId
    Should Not Be Equal    ${summary['planId']}    ${None}    fixture scan must produce a plan
    Should Be True    ${summary['candidateCount']} > 0
    Should Be True    ${summary['scannedFiles']} > 0

Disk Status Json Parses
    [Documentation]    Real volumes/SMART/trim advice; --root only bounds the
    ...                top-level breakdown walk so the test finishes quickly.
    ${result}=    Run Core Cli    disk    status    --root    ${SANDBOX}    --json
    Should Be Equal As Integers    ${result.rc}    0    disk status failed: ${result.stderr}
    ${status}=    Evaluate    json.loads($result.stdout)    json
    Should Not Be Empty    ${status['volumes']}
    FOR    ${vol}    IN    @{status['volumes']}
        Dictionary Should Contain Key    ${vol}    mount
        Dictionary Should Contain Key    ${vol}    sizeBytes
        Dictionary Should Contain Key    ${vol}    usePercent
    END
    ${msg_type}=    Evaluate    type($status['trimAdvice']['message']).__name__
    Should Be Equal    ${msg_type}    str
    ${bd_type}=    Evaluate    type($status['breakdown']).__name__
    Should Be Equal    ${bd_type}    list

Procs List Json Parses
    [Documentation]    Read-only real-mode process listing.
    ...
    ...                BUG-002 (engine hang on TCC-blocked osascript) is FIXED
    ...                (see BUGS.md). The tag remains for a TEST-HARNESS
    ...                limitation: Robot's Run Process with timeout= polls
    ...                process.poll() without draining the stdout PIPE, so any
    ...                output > 64KB (large process tables) deadlocks the child
    ...                until the kill timeout. Fix is QA-side: redirect stdout
    ...                to a file in Run Core Cli, then drop this tag.
    [Tags]    known-bug
    ${result}=    Run Core Cli    procs    list    --json    timeout=60 s
    Should Be Equal As Integers    ${result.rc}    0    procs list hung or failed (rc ${result.rc}): ${result.stderr}
    ${procs}=    Evaluate    json.loads($result.stdout)    json
    Should Not Be Empty    ${procs}
    ${first}=    Set Variable    ${procs[0]}
    ${pid_ok}=    Evaluate    isinstance($first['pid'], int) and $first['pid'] > 0
    Should Be True    ${pid_ok}
    Should Not Be Empty    ${first['name']}
    ${flags_ok}=    Evaluate    all(isinstance(p['isSystem'], bool) and isinstance(p['memBytes'], (int, float)) for p in $procs)
    Should Be True    ${flags_ok}    every ProcInfo needs boolean isSystem and numeric memBytes

*** Keywords ***
Contract Suite Setup
    Require Cli Build
    ${sandbox}=    Build Fixture Sandbox
    Set Suite Variable    ${SANDBOX}    ${sandbox}
    ${db}=    Make Temp Db
    Set Suite Variable    ${DB}    ${db}
    ${result}=    Run Sandbox Scan    ${SANDBOX}    ${DB}
    Set Suite Variable    ${SCAN_STDOUT}    ${result.stdout}

Contract Suite Teardown
    Cleanup Sandbox    ${SANDBOX}
