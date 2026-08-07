*** Settings ***
Documentation     The human gate and the quarantine/undo cycle. Tests in this
...               suite form an ordered flow over one sandbox: refuse without
...               approvals -> dry-run is side-effect-free -> approved exec
...               quarantines -> undo restores. The graph DB lives OUTSIDE the
...               sandbox tree, so tree checksums only see engine side effects.
Resource          resources${/}common.resource
Suite Setup       Exec Suite Setup
Suite Teardown    Cleanup Sandbox    ${SANDBOX}
Test Tags         exec-gate

*** Variables ***
${SANDBOX}          ${EMPTY}
${DB}               ${EMPTY}
${PLAN}             ${EMPTY}
${TARGET}           ${EMPTY}    # verdict dict for Caches/app1/blob.cache
${BASELINE}         ${EMPTY}    # tree checksum before any exec attempt
${ORIGINAL_SHA}     ${EMPTY}
${RECEIPT_ID}       ${EMPTY}
${TRASH_REF}        ${EMPTY}

*** Test Cases ***
Exec Without Approve Ids Is Refused
    ${result}=    Run Core Cli    exec    --plan    ${PLAN['planId']}    --root    ${SANDBOX}    --db    ${DB}    --json
    Should Be Equal As Integers    ${result.rc}    2    the human gate must refuse with CLI_EXIT.REFUSED
    ${err}=    Evaluate    json.loads($result.stdout)    json
    Should Be Equal    ${err}    ${{{'error': 'approval required'}}}
    ${quarantine}=    Quarantine Dir Of    ${SANDBOX}
    Directory Should Not Exist    ${quarantine}
    ${after}=    Tree Checksum    ${SANDBOX}
    Should Be Equal    ${after}    ${BASELINE}    refused exec must have zero filesystem side effects

Dry Run Leaves Every File Untouched
    ${result}=    Run Core Cli    exec    --plan    ${PLAN['planId']}    --approve-ids    ${TARGET['id']}
    ...    --dry-run    --root    ${SANDBOX}    --db    ${DB}    --json
    Should Be Equal As Integers    ${result.rc}    0    dry-run failed: ${result.stderr}
    ${exec}=    Evaluate    json.loads($result.stdout)    json
    Should Be Equal As Integers    ${exec['executed']}    1
    Should Be Equal As Integers    ${exec['failed']}    0
    Should Be Equal    ${exec['receipts'][0]['action']}    dry-run
    Should Be Equal    ${exec['receipts'][0]['trashRef']}    ${None}
    ${quarantine}=    Quarantine Dir Of    ${SANDBOX}
    Directory Should Not Exist    ${quarantine}
    ${after}=    Tree Checksum    ${SANDBOX}
    Should Be Equal    ${after}    ${BASELINE}    dry-run must be side-effect-free on the scanned tree

Approved Exec Quarantines The File And Writes A Receipt
    ${result}=    Run Core Cli    exec    --plan    ${PLAN['planId']}    --approve-ids    ${TARGET['id']}
    ...    --root    ${SANDBOX}    --db    ${DB}    --json
    Should Be Equal As Integers    ${result.rc}    0    exec failed: ${result.stderr}
    ${exec}=    Evaluate    json.loads($result.stdout)    json
    Should Be Equal As Integers    ${exec['executed']}    1
    Should Be Equal As Integers    ${exec['failed']}    0
    Should Be True    ${exec['bytesFreed']} > 0
    ${receipt}=    Set Variable    ${exec['receipts'][0]}
    Should Be True    ${receipt['ok']}
    Should Be Equal    ${receipt['action']}    trash
    Should Be Equal    ${receipt['path']}    ${TARGET['subjectKey']}
    Should Be True    ${receipt['bytesFreed']} > 0
    File Should Not Exist    ${TARGET['subjectKey']}
    ${quarantine}=    Quarantine Dir Of    ${SANDBOX}
    ${in_quarantine}=    Is Within    ${receipt['trashRef']}    ${quarantine}
    Should Be True    ${in_quarantine}    trashRef must live under ${quarantine}: ${receipt['trashRef']}
    File Should Exist    ${receipt['trashRef']}
    ${quarantined_sha}=    File Sha256    ${receipt['trashRef']}
    Should Be Equal    ${quarantined_sha}    ${ORIGINAL_SHA}    quarantined bytes differ from the original
    Set Suite Variable    ${RECEIPT_ID}    ${receipt['id']}
    Set Suite Variable    ${TRASH_REF}    ${receipt['trashRef']}

Receipt Is Persisted And Verdict Marked Executed In The Plan Db
    ${plan}=    Get Plan    ${PLAN['runId']}    ${DB}
    ${v}=    Find Verdict By Basename    ${plan}    blob.cache    junk
    Should Be Equal    ${v['status']}    executed

Undo Restores The File To Its Original Path
    ${result}=    Run Core Cli    undo    --receipt    ${RECEIPT_ID}    --db    ${DB}    --json
    Should Be Equal As Integers    ${result.rc}    0    undo failed: ${result.stderr}
    ${undo}=    Evaluate    json.loads($result.stdout)    json
    Should Be True    ${undo['ok']}
    File Should Exist    ${TARGET['subjectKey']}
    ${restored_sha}=    File Sha256    ${TARGET['subjectKey']}
    Should Be Equal    ${restored_sha}    ${ORIGINAL_SHA}    restored content must be byte-identical
    File Should Not Exist    ${TRASH_REF}
    ${plan}=    Get Plan    ${PLAN['runId']}    ${DB}
    ${v}=    Find Verdict By Basename    ${plan}    blob.cache    junk
    Should Be Equal    ${v['status']}    undone

*** Keywords ***
Exec Suite Setup
    Require Cli Build
    ${sandbox}=    Build Fixture Sandbox
    Set Suite Variable    ${SANDBOX}    ${sandbox}
    ${db}=    Make Temp Db
    Set Suite Variable    ${DB}    ${db}
    ${result}=    Run Sandbox Scan    ${SANDBOX}    ${DB}    categories=junk
    ${summary}=    Get Summary From Scan Output    ${result.stdout}
    ${plan}=    Get Plan    ${summary['runId']}    ${DB}
    Set Suite Variable    ${PLAN}    ${plan}
    ${target}=    Find Verdict By Basename    ${plan}    blob.cache    junk
    Set Suite Variable    ${TARGET}    ${target}
    ${sha}=    File Sha256    ${target['subjectKey']}
    Set Suite Variable    ${ORIGINAL_SHA}    ${sha}
    ${baseline}=    Tree Checksum    ${SANDBOX}
    Set Suite Variable    ${BASELINE}    ${baseline}
