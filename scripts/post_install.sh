#!/usr/bin/env bash

set -euo pipefail

. ./scripts/is_root.sh

only_allow_git_root

ENV_FILE="$GIT_ROOT/.env"
TEMP_ENV_FILE="$GIT_ROOT/.env.temp"
EXAMPLE_FILE="$GIT_ROOT/.env.example"

get_env_value() {
    local var_key="$1"
    local file="$2"

    if [ -f "$file" ]; then
        grep "^${var_key}=" "$file" 2>/dev/null | cut -d'=' -f2- || true
    fi
}

merge_env_files() {
    local example="$1"
    local existing="$2"
    local output="$3"

    if [ ! -f "$example" ]; then
        echo "ERROR: Missing $example" >&2
        exit 1
    fi

    if [ ! -f "$existing" ]; then
        cp "$example" "$output"
        echo "INFO: Created .env from .env.example"
        return
    fi

    if [ "$existing" = "$output" ]; then
        cp "$existing" "$TEMP_ENV_FILE"
        output="$TEMP_ENV_FILE"
    else
        cp "$existing" "$output"
    fi

    while IFS= read -r line || [ -n "$line" ]; do
        if [[ -z "$line" || "$line" =~ ^# ]]; then
            continue
        fi

        key=$(echo "$line" | cut -d'=' -f1)

        if ! grep -q "^${key}=" "$output" 2>/dev/null; then
            echo "$line" >> "$output"
            echo "INFO: Added missing key $key"
        fi
    done < "$example"

    if [ "$output" = "$TEMP_ENV_FILE" ]; then
        mv "$TEMP_ENV_FILE" "$existing"
    fi
}

set_env_value() {
    local var_key="$1"
    local var_value="$2"
    local existing_value

    existing_value=$(get_env_value "$var_key" "$ENV_FILE")

    if [ -n "$existing_value" ]; then
        echo "INFO: $var_key already has a value. Skipping."
        return
    fi

    awk -v key="$var_key" -v value="$var_value" '
    {
        if ($0 ~ ("^" key "=")) {
            print key "=" value;
            next;
        }
        print $0;
    }
    ' "$ENV_FILE" > "$TEMP_ENV_FILE"

    mv "$TEMP_ENV_FILE" "$ENV_FILE"
    echo "INFO: Auto-generated $var_key."
}

create_symlink() {
    local target_dir="$1"
    local link_path="$target_dir/.env"

    if [ ! -d "$target_dir" ]; then
        return
    fi

    if [ -L "$link_path" ]; then
        rm "$link_path"
    elif [ -f "$link_path" ]; then
        echo "WARN: $link_path is a regular file, skipping symlink."
        return
    fi

    local relative_path
    relative_path=$(python3 -c "import os.path; print(os.path.relpath('$ENV_FILE', '$target_dir'))")
    ln -s "$relative_path" "$link_path"
    echo "INFO: Created symlink $link_path -> $relative_path"
}

merge_env_files "$EXAMPLE_FILE" "$ENV_FILE" "$ENV_FILE"

set_env_value "BETTER_AUTH_SECRET" "$(openssl rand -hex 32)"
set_env_value "POSTGRES_PASSWORD" "$(openssl rand -hex 24)"
set_env_value "RABBITMQ_PASSWORD" "$(openssl rand -hex 24)"
set_env_value "BIFROST_ADMIN_PASSWORD" "$(openssl rand -hex 24)"
set_env_value "BIFROST_POSTGRES_PASSWORD" "$(openssl rand -hex 24)"
# Encrypts stored virtual keys and Macro secrets. Generated once: replacing it
# later makes everything already stored unreadable.
set_env_value "ENCRYPTION_KEY" "$(openssl rand -hex 32)"
set_env_value "AGENT_TOKEN" "$(openssl rand -hex 32)"
set_env_value "SCHEDULER_ADMIN_TOKEN" "$(openssl rand -hex 32)"

echo ""
echo "INFO: Creating .env symlinks..."

create_symlink "$GIT_ROOT/infra"

for dir in "$GIT_ROOT"/apps/*/; do
    create_symlink "$dir"
done

for dir in "$GIT_ROOT"/packages/*/; do
    create_symlink "$dir"
done

for dir in "$GIT_ROOT"/services/*/; do
    create_symlink "$dir"
done

create_symlink "$GIT_ROOT/tests"

echo ""
echo "INFO: .env setup complete. Fill provider-specific values before production."
