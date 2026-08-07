*** Settings ***
Documentation     Safety rules — protected OS roots are refused, junk never
...               proposes user content (Documents/**), and everything the
...               executor quarantines stays inside the sandbox.
...
...               NOTE: a plan with a doctored protected path cannot be built
...               through the CLI at all — exec only takes --approve-ids
...               against verdicts the engine itself produced (approve-only-ids
...               design), so the "protected path reaches the executor" case is
...               covered by unit tests, and here we assert the scanner/verifier
...               layers structurally: Documents items never become candidates.
Resource          resources${/}common.resource
Suite Setup       Safety Suite Setup
Suite Teardown    Cleanup Sandbox    ${SANDBOX}
Test Tags         safety

*** Variables ***
${SANDBOX}        ${EMPTY}
${DB}             ${EMPTY}
${PLAN}           ${EMPTY}

*** Test Cases ***
Scan Of Protected OS Root Is Refused With Exit 2
    [Documentation]    /System on macOS, C:\\Windows on Windows — refusal, not error.
    ${root}=    Protected Scan Root
    ${db}=    Make Temp Db
    ${result}=    Run Core Cli    scan    --root    ${root}    --db    ${db}    --json
    Should Be Equal As Integers    ${result.rc}    2    expected CLI_EXIT.REFUSED for root ${root}
    ${err}=    Evaluate    json.loads($result.stdout)    json
    Dictionary Should Contain Key    ${err}    error
    Should Contain    ${err['error']}    refusing to scan protected root

Junk Scan Never Proposes Documents Items
    ${bad}=    Subjects With Segment    ${PLAN}    Documents
    Should Be Empty    ${bad}    junk candidates found under Documents: ${bad}
    ${subjects}=    Subject Keys    ${PLAN}
    ${basenames}=    Evaluate    [__import__('os').path.basename(s) for s in $subjects]
    Should Not Contain    ${basenames}    keep.log
    Should Not Contain    ${basenames}    important.txt

Junk Scan Never Proposes Desktop Or Pictures Items
    ${desktop}=    Subjects With Segment    ${PLAN}    Desktop
    ${pictures}=    Subjects With Segment    ${PLAN}    Pictures
    Should Be Empty    ${desktop}
    Should Be Empty    ${pictures}

Executed Items Are Quarantined Inside The Sandbox
    ${verdict}=    Find Verdict By Basename    ${PLAN}    blob.cache    junk
    ${result}=    Run Core Cli    exec    --plan    ${PLAN['planId']}    --approve-ids    ${verdict['id']}
    ...    --root    ${SANDBOX}    --db    ${DB}    --json
    Should Be Equal As Integers    ${result.rc}    0    exec failed: ${result.stderr}
    ${exec}=    Evaluate    json.loads($result.stdout)    json
    Should Be Equal As Integers    ${exec['executed']}    1
    ${quarantine}=    Quarantine Dir Of    ${SANDBOX}
    Directory Should Exist    ${quarantine}
    FOR    ${receipt}    IN    @{exec['receipts']}
        ${in_quarantine}=    Is Within    ${receipt['trashRef']}    ${quarantine}
        Should Be True    ${in_quarantine}    trashRef escaped the sandbox quarantine: ${receipt['trashRef']}
        ${in_sandbox}=    Is Within    ${receipt['trashRef']}    ${SANDBOX}
        Should Be True    ${in_sandbox}
    END
    File Should Not Exist    ${verdict['subjectKey']}

*** Keywords ***
Safety Suite Setup
    Require Cli Build
    ${sandbox}=    Build Fixture Sandbox
    Set Suite Variable    ${SANDBOX}    ${sandbox}
    ${db}=    Make Temp Db
    Set Suite Variable    ${DB}    ${db}
    ${result}=    Run Sandbox Scan    ${SANDBOX}    ${DB}    categories=junk
    ${summary}=    Get Summary From Scan Output    ${result.stdout}
    ${plan}=    Get Plan    ${summary['runId']}    ${DB}
    Set Suite Variable    ${PLAN}    ${plan}
