#!/usr/bin/env bash

require_envs() {
    local is_missing_vars=0

    if [ "$#" -eq 0 ]; then
        echo "Usage: require_envs <variable1> <variable2>..." >&2
        exit 1
    fi

    for var in "$@"; do
        if [ -z "${!var}" ]; then
            echo "ERROR: Required environment variable '$var' is not set." >&2
            is_missing_vars=1
        fi
    done

    if [ "$is_missing_vars" -eq 1 ]; then
        exit 1
    fi
}
