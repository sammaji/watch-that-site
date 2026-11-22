package utils

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
)

// MustEnv returns the value of the environment variable named by the key
// or panics if the key is not set.
func MustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic(fmt.Sprintf("required env var %s is not set", key))
	}
	return v
}

// GetEnv returns the value of the environment variable named by the key
func GetEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// GetEnvInt returns the value of the environment variable as integer
// and returns the fallback value if the environment variable is not set or
// the value is not a valid integer.
func GetEnvInt(k string, fallback int) int {
	v := os.Getenv(k)
	if v == "" {
		return fallback
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return i
}

// GetLogLevel returns the log level based on the LOG_LEVEL environment variable.
// If the environment variable is not set, it returns the default log level.
func GetLogLevel() slog.Level {
	switch os.Getenv("LOG_LEVEL") {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// Coalesce returns the first non-empty string from the given slice of strings.
func Coalesce(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// Ptr returns pointer to the given value.
func Ptr[T any](v T) *T {
	return &v
}
