*** Settings ***
Documentation     Duplicate detection — entity-resolution pipeline against the
...               fixture: photo.jpg and photo-copy.jpg are byte-identical;
...               other.jpg has the same size, extension AND the same first/last
...               64KB (so it survives blocking and partial hashing) but a
...               different middle — only the full hash may reject it.
...
...               Engine group model: only NON-canonical members appear as
...               verdicts (smartSelected true); the canonical member is
...               identified by detail.canonicalPath and is structurally absent
...               from the plan — it can never be selected, which satisfies
...               "canonical is not smart-selected" by construction.
Resource          resources${/}common.resource
Suite Setup       Duplicates Suite Setup
Suite Teardown    Cleanup Sandbox    ${SANDBOX}
Test Tags         duplicates

*** Variables ***
${SANDBOX}        ${EMPTY}
${DB}             ${EMPTY}
${PLAN}           ${EMPTY}

*** Test Cases ***
Identical Files Are Grouped Together
    ${groups}=    Duplicate Groups    ${PLAN}
    ${count}=    Get Length    ${groups}
    Should Be Equal As Integers    ${count}    1    expected exactly one duplicate group, got: ${groups}
    ${group}=    Evaluate    list($groups.values())[0]
    ${membership}=    Evaluate    sorted(__import__('os').path.basename(p) for p in $group['members'] + $group['canonicals'])
    Should Be Equal    ${membership}    ${{['photo-copy.jpg', 'photo.jpg']}}

False Positive Guard Keeps Other Jpg Out Of The Group
    [Documentation]    Same size/ext and identical partial-hash blocks must not
    ...                be enough — full-hash confirmation is required.
    ${subjects}=    Subject Keys    ${PLAN}    duplicate
    ${groups}=    Duplicate Groups    ${PLAN}
    ${all_paths}=    Evaluate    $subjects + [c for g in $groups.values() for c in g['canonicals']]
    ${hits}=    Evaluate    [p for p in $all_paths if __import__('os').path.basename(p) == 'other.jpg']
    Should Be Empty    ${hits}    other.jpg was falsely resolved into a duplicate group

Exactly One Canonical Per Group And It Is Never Proposed
    ${groups}=    Duplicate Groups    ${PLAN}
    ${subjects}=    Subject Keys    ${PLAN}    duplicate
    FOR    ${gid}    IN    @{groups}
        ${group}=    Get From Dictionary    ${groups}    ${gid}
        ${n_canonical}=    Get Length    ${group['canonicals']}
        Should Be Equal As Integers    ${n_canonical}    1    group ${gid} has ${n_canonical} distinct canonicals
        ${canonical}=    Set Variable    ${group['canonicals'][0]}
        Should Not Contain    ${subjects}    ${canonical}    canonical ${canonical} is itself proposed for deletion
        File Should Exist    ${canonical}
    END

Canonical Choice Follows The Merge Policy
    [Documentation]    Neither copy is under Documents/Pictures/Desktop, so the
    ...                oldest mtime wins: photo.jpg (fixture backdates it 1 day).
    ${groups}=    Duplicate Groups    ${PLAN}
    ${group}=    Evaluate    list($groups.values())[0]
    ${canonical_base}=    Evaluate    __import__('os').path.basename($group['canonicals'][0])
    Should Be Equal    ${canonical_base}    photo.jpg

Non Canonical Members Are Smart Selected
    ${dups}=    Verdicts Of Category    ${PLAN}    duplicate
    Should Not Be Empty    ${dups}
    FOR    ${v}    IN    @{dups}
        Should Be True    ${v['smartSelected']}    non-canonical member ${v['subjectKey']} must be smart-selected
        Should Be Equal    ${v['action']}    trash
        Should Be Equal    ${v['provenance']['rule']}    dup.full-hash
    END

*** Keywords ***
Duplicates Suite Setup
    Require Cli Build
    ${sandbox}=    Build Fixture Sandbox
    Set Suite Variable    ${SANDBOX}    ${sandbox}
    ${db}=    Make Temp Db
    Set Suite Variable    ${DB}    ${db}
    ${result}=    Run Sandbox Scan    ${SANDBOX}    ${DB}    categories=duplicate
    ${summary}=    Get Summary From Scan Output    ${result.stdout}
    ${plan}=    Get Plan    ${summary['runId']}    ${DB}
    Set Suite Variable    ${PLAN}    ${plan}
