#!/bin/bash
# -*- firestarter: "shfmt -i 4 -ci -w %p" -*-

set -euxo pipefail

readonly test_part=${TEST_PART:-}

case "$test_part" in
Sol5)
    npx buidler test --no-compile --config buidlerCoverageSol5.js
    ;;
Coverage)
    if [[ $TRAVIS_EVENT_TYPE != "push" ]]; then
        echo "Only running coverage on merge request or direct push"
    elif [[ $TRAVIS_BRANCH == $COVERAGE_BRANCH ]]; then
        ./coverage.sh
    else
        echo "Not running coverage on $TRAVIS_BRANCH"
    fi
    ;;
*)
    echo "test case not define yet"
    ;;
esac