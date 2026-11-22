module github.com/sammaji/watchthatsite/scripts/seeder

go 1.26.2

replace github.com/sammaji/watchthatsite/services/core => ../../services/core

require (
	github.com/brianvoe/gofakeit/v7 v7.15.0
	github.com/jackc/pgx/v5 v5.9.2
	github.com/sammaji/watchthatsite/services/core v0.0.0
)

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	golang.org/x/sync v0.17.0 // indirect
	golang.org/x/text v0.29.0 // indirect
)
