#!/usr/bin/env bash

git_root() {
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        return 1
    fi

    git rev-parse --show-toplevel
}

only_allow_git_root() {
    GIT_ROOT=$(git_root)

    if [ $? -ne 0 ]; then
        echo "ERROR: Not inside a Git working tree." >&2
        exit 1
    fi

    if [ "$GIT_ROOT" != "$PWD" ]; then
        echo "ERROR: Run this script from the repository root: $GIT_ROOT" >&2
        exit 1
    fi

    echo "INFO: Git root: $GIT_ROOT"
}
