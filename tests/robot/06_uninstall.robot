*** Settings ***
Documentation     Sandbox app uninstall — the graph traversal (OWNED_BY) drives
...               the orphan cleanup: uninstalling com.toy quarantines both the
...               Toy.app bundle and its owned Library path, while the Library
...               tree itself survives.
Resource          resources${/}common.resource
Suite Setup       Uninstall Suite Setup
Suite Teardown    Cleanup Sandbox    ${SANDBOX}
Test Tags         uninstall

*** Variables ***
${SANDBOX}        ${EMPTY}
${DB}             ${EMPTY}

*** Test Cases ***
Apps List Finds The Sandbox App
    ${result}=    Run Core Cli    apps    list    --root    ${SANDBOX}    --db    ${DB}    --json
    Should Be Equal As Integers    ${result.rc}    0    apps list failed: ${result.stderr}
    ${apps}=    Evaluate    json.loads($result.stdout)    json
    ${toy}=    Evaluate    next((a for a in $apps if a['key'] == 'com.toy'), None)
    Should Not Be Equal    ${toy}    ${None}    com.toy missing from apps list: ${result.stdout}
    Should Be Equal    ${toy['name']}    Toy
    Should Be Equal    ${toy['version']}    1.0.0
    Should End With    ${toy['installPath']}    Toy.app
    ${owned_count}=    Get Length    ${toy['ownedPaths']}
    Should Be Equal As Integers    ${owned_count}    1
    ${owned_in_sandbox}=    Is Within    ${toy['ownedPaths'][0]}    ${SANDBOX}
    Should Be True    ${owned_in_sandbox}    ownedPaths must resolve inside the sandbox root

Uninstall Quarantines Bundle And Owned Path
    ${bundle}=    Join Path    ${SANDBOX}    Applications    Toy.app
    ${owned}=    Join Path    ${SANDBOX}    Library    Application Support    Toy
    Directory Should Exist    ${bundle}
    Directory Should Exist    ${owned}
    ${result}=    Run Core Cli    apps    uninstall    --key    com.toy    --root    ${SANDBOX}    --db    ${DB}    --json
    Should Be Equal As Integers    ${result.rc}    0    uninstall failed: ${result.stdout} ${result.stderr}
    ${res}=    Evaluate    json.loads($result.stdout)    json
    Should Be True    ${res['ok']}
    ${actions}=    Evaluate    sorted(r['action'] for r in $res['receipts'])
    Should Be Equal    ${actions}    ${{['uninstall', 'uninstall-owned']}}
    Directory Should Not Exist    ${bundle}
    Directory Should Not Exist    ${owned}
    ${quarantine}=    Quarantine Dir Of    ${SANDBOX}
    FOR    ${receipt}    IN    @{res['receipts']}
        Should Be True    ${receipt['ok']}    receipt not ok: ${receipt}
        ${in_quarantine}=    Is Within    ${receipt['trashRef']}    ${quarantine}
        Should Be True    ${in_quarantine}    trashRef outside sandbox quarantine: ${receipt['trashRef']}
        Should Exist    ${receipt['trashRef']}
    END
    ${data_hits}=    Evaluate    [os.path.join(dp, f) for dp, dn, fn in os.walk($quarantine) for f in fn if f == 'data.bin']    modules=os
    ${n_data}=    Get Length    ${data_hits}
    Should Be Equal As Integers    ${n_data}    1    owned data.bin must be preserved inside quarantine

Library Dir Itself Still Exists
    ${library}=    Join Path    ${SANDBOX}    Library
    ${app_support}=    Join Path    ${SANDBOX}    Library    Application Support
    Directory Should Exist    ${library}
    Directory Should Exist    ${app_support}
    ${documents}=    Join Path    ${SANDBOX}    Documents    important.txt
    File Should Exist    ${documents}

*** Keywords ***
Uninstall Suite Setup
    Require Cli Build
    ${sandbox}=    Build Fixture Sandbox
    Set Suite Variable    ${SANDBOX}    ${sandbox}
    ${db}=    Make Temp Db
    Set Suite Variable    ${DB}    ${db}
