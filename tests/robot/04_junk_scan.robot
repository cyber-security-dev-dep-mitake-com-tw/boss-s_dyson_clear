*** Settings ***
Documentation     Junk scan (sandbox rules) — all four planted junk files are
...               candidates with sandbox.junk.* provenance; Documents content
...               is never proposed; confidences sit inside the SAFETY-RULES
...               bands and smart-selection only happens in the Safe band.
Resource          resources${/}common.resource
Suite Setup       Junk Suite Setup
Suite Teardown    Cleanup Sandbox    ${SANDBOX}
Test Tags         junk

*** Variables ***
${SANDBOX}        ${EMPTY}
${DB}             ${EMPTY}
${PLAN}           ${EMPTY}
@{PLANTED_JUNK}    blob.cache    scratch.tmp    old.log    x.bin

*** Test Cases ***
All Planted Junk Files Are Candidates
    ${junk}=    Verdicts Of Category    ${PLAN}    junk
    ${count}=    Get Length    ${junk}
    Should Be Equal As Integers    ${count}    4    expected exactly the 4 planted junk files, got: ${junk}
    FOR    ${basename}    IN    @{PLANTED_JUNK}
        ${v}=    Find Verdict By Basename    ${PLAN}    ${basename}    junk
        Should Be Equal    ${v['action']}    trash
        Should Be Equal    ${v['status']}    proposed
    END

Junk Provenance Rules Start With sandbox.junk
    ${junk}=    Verdicts Of Category    ${PLAN}    junk
    FOR    ${v}    IN    @{junk}
        Should Start With    ${v['provenance']['rule']}    sandbox.junk    ${v['subjectKey']} has rule ${v['provenance']['rule']}
        Should Be Equal    ${v['provenance']['scanner']}    junk-scanner@1
        Dictionary Should Contain Key    ${v['provenance']['evidence']}    path
    END

Documents Files Are Absent From The Plan
    ${bad}=    Subjects With Segment    ${PLAN}    Documents
    Should Be Empty    ${bad}    Documents content proposed as junk: ${bad}
    ${subjects}=    Subject Keys    ${PLAN}
    ${basenames}=    Evaluate    [__import__('os').path.basename(s) for s in $subjects]
    Should Not Contain    ${basenames}    keep.log    keep.log (a *.log inside Documents) must never be a candidate
    Should Not Contain    ${basenames}    important.txt

Confidence Values Sit Within The SAFETY-RULES Bands
    [Documentation]    Dir-matched sandbox junk is 0.9 (Safe band, >= 0.90);
    ...                smartSelected is only legal in the Safe band (par. 3.3).
    ${junk}=    Verdicts Of Category    ${PLAN}    junk
    FOR    ${v}    IN    @{junk}
        ${conf}=    Set Variable    ${v['provenance']['confidence']}
        Should Be True    0 <= ${conf} <= 1
        Should Be True    ${conf} >= 0.9    dir-matched sandbox junk must be Safe band: ${v['subjectKey']} has ${conf}
        Should Be True    not ${v['smartSelected']} or ${conf} >= 0.9    smart-selected item below the Safe band: ${v['subjectKey']}
    END

Loose Junk In Probably-Safe Band Is Not Smart Selected
    [Documentation]    SAFETY-RULES par. 3.3: smartSelected <=> Safe band (>= 0.90).
    ...                A loose *.tmp file matches at confidence 0.7 ("Probably
    ...                safe": listed, unchecked) and must NOT be smart-selected.
    ${sandbox2}=    Make Temp Dir    sweepdeck-loose-
    ${db2}=    Make Temp Db
    Create File    ${sandbox2}${/}stray.tmp    loose temp file
    ${result}=    Run Sandbox Scan    ${sandbox2}    ${db2}    categories=junk
    ${summary}=    Get Summary From Scan Output    ${result.stdout}
    ${plan}=    Get Plan    ${summary['runId']}    ${db2}
    ${v}=    Find Verdict By Basename    ${plan}    stray.tmp    junk
    Cleanup Sandbox    ${sandbox2}
    Should Be True    ${v['provenance']['confidence']} < 0.9    precondition: loose junk is below the Safe band
    Should Not Be True    ${v['smartSelected']}    Probably-safe band item is smart-selected (violates SAFETY-RULES par. 3.3)

*** Keywords ***
Junk Suite Setup
    Require Cli Build
    ${sandbox}=    Build Fixture Sandbox
    Set Suite Variable    ${SANDBOX}    ${sandbox}
    ${db}=    Make Temp Db
    Set Suite Variable    ${DB}    ${db}
    ${result}=    Run Sandbox Scan    ${SANDBOX}    ${DB}    categories=junk
    ${summary}=    Get Summary From Scan Output    ${result.stdout}
    ${plan}=    Get Plan    ${summary['runId']}    ${DB}
    Set Suite Variable    ${PLAN}    ${plan}
