package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const lockID int64 = 892920250502

var datedMigrationPattern = regexp.MustCompile(`^migration_[0-9]{4}_[0-9]{2}_[0-9]{2}_.+\.sql$`)

type strategy string

const (
	strategyRunOnce strategy = "run_once"
	strategyHash    strategy = "hash"
	strategyAlways  strategy = "always"
)

type migration struct {
	name string // name of the migration stored in the database (same as the filename without .sql)
	path string // file path to the migration

	// hash of the migration file, used to check if the contents of the file
	// changed, in that case its run again.
	hash string

	// it is recommened to structure migration files in a way that they are
	// idempotent, so that stategy "hash" or "always" do not create a drift.
	// otherwise, use "run_once".
	strategy strategy
}

type migrationRecord struct {
	hash string
}

func main() {
	log.SetFlags(0)
	ctx := context.Background()

	databaseURL := flag.String("database-url", os.Getenv("DATABASE_URL"), "PostgreSQL connection string")

	dir := flag.String("dir", defaultMigrationDir(), "Migration directory (default ./packages/db/migrations)")
	flag.Parse()

	if *databaseURL == "" {
		postgresDatabase := mustEnv("POSTGRES_DATABASE")
		postgresHost := mustEnv("POSTGRES_HOST")
		postgresPort := mustEnv("POSTGRES_PORT")
		postgresUser := mustEnv("POSTGRES_USER")
		postgresPassword := mustEnv("POSTGRES_PASSWORD")
		*databaseURL = fmt.Sprintf("postgres://%s:%s@%s:%s/%s", postgresUser, postgresPassword, postgresHost, postgresPort, postgresDatabase)
	}

	if err := validateDatedMigrationNames(*dir); err != nil {
		log.Fatalf("ERROR: %v", err)
	}

	migrations, err := planMigrations(*dir)
	if err != nil {
		log.Fatalf("ERROR: %v", err)
	}

	db, err := sql.Open("pgx", *databaseURL)
	if err != nil {
		log.Fatalf("ERROR: open database: %v", err)
	}
	defer db.Close()

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(5 * time.Minute)

	conn, err := db.Conn(ctx)
	if err != nil {
		log.Fatalf("ERROR: acquire connection: %v", err)
	}
	defer conn.Close()

	if err := withAdvisoryLock(ctx, conn, func() error {
		if err := ensureMigrationTable(ctx, conn); err != nil {
			return err
		}

		for _, migration := range migrations {
			if err := runMigration(ctx, conn, migration); err != nil {
				log.Printf("ERROR: %v", err)
			}
		}

		if _, err := conn.ExecContext(ctx, "NOTIFY pgrst, 'reload schema'"); err != nil {
			return fmt.Errorf("Failed to notify pgrst: %w", err)
		} else {
			log.Println("INFO: Notified pgrst.")
		}

		return nil
	}); err != nil {
		log.Fatalf("ERROR: %v", err)
	}

	log.Println("INFO: Migrations completed successfully.")
}

func defaultMigrationDir() string {
	cwd, err := os.Getwd()
	if err != nil {
		return filepath.Join("packages", "db", "migrations")
	}

	for dir := cwd; ; dir = filepath.Dir(dir) {
		candidate := filepath.Join(dir, "packages", "db", "migrations")
		if stat, err := os.Stat(candidate); err == nil && stat.IsDir() {
			return candidate
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}

	return filepath.Join("packages", "db", "migrations")
}

func planMigrations(dir string) ([]migration, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read migration directory %s: %w", dir, err)
	}

	byName := make(map[string]string)
	var dated []string

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".sql" {
			continue
		}

		path := filepath.Join(dir, entry.Name())
		byName[entry.Name()] = path

		if strings.HasPrefix(entry.Name(), "migration_") {
			dated = append(dated, entry.Name())
		}
	}

	sort.Strings(dated)

	var plan []migration
	add := func(name string, strategy strategy) error {
		path, ok := byName[name]
		if !ok {
			return fmt.Errorf("missing required migration file %s", filepath.Join(dir, name))
		}
		migration, err := newMigration(name, path, strategy)
		if err != nil {
			return err
		}
		plan = append(plan, migration)
		return nil
	}

	if err := add("better-auth_migrations.sql", strategyHash); err != nil {
		return nil, err
	}

	// schema.sql holds every product table and runs once on an empty
	// database; dated migrations are later changes on top of it.
	if err := add("schema.sql", strategyRunOnce); err != nil {
		return nil, err
	}

	for _, name := range dated {
		migration, err := newMigration(name, byName[name], strategyRunOnce)
		if err != nil {
			return nil, err
		}
		plan = append(plan, migration)
	}

	if err := add("functions.sql", strategyHash); err != nil {
		return nil, err
	}

	if err := add("rls.sql", strategyAlways); err != nil {
		return nil, err
	}

	return plan, nil
}

func newMigration(name, path string, strategy strategy) (migration, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return migration{}, fmt.Errorf("read migration %s: %w", path, err)
	}

	if strings.TrimSpace(string(content)) == "" {
		return migration{}, fmt.Errorf("migration %s is empty", path)
	}

	sum := sha256.Sum256(content)

	return migration{
		name:     name,
		path:     path,
		hash:     hex.EncodeToString(sum[:]),
		strategy: strategy,
	}, nil
}

func withAdvisoryLock(ctx context.Context, conn *sql.Conn, fn func() error) error {
	log.Println("INFO: Acquiring migration lock...")

	if _, err := conn.ExecContext(ctx, "select pg_advisory_lock($1)", lockID); err != nil {
		return fmt.Errorf("acquire advisory lock: %w", err)
	}

	defer func() {
		if _, err := conn.ExecContext(context.Background(), "select pg_advisory_unlock($1)", lockID); err != nil {
			log.Printf("WARN: failed to release migration lock: %v", err)
		}
	}()

	return fn()
}

func ensureMigrationTable(ctx context.Context, conn *sql.Conn) error {
	_, err := conn.ExecContext(ctx, `
create table if not exists _migrations (
  name text primary key,
  strategy text not null,
  hash text not null,
  run_count integer not null default 0,
  executed_at timestamptz not null default now()
)`)
	if err != nil {
		return fmt.Errorf("ensure _migrations table: %w", err)
	}
	return nil
}

func runMigration(ctx context.Context, conn *sql.Conn, migration migration) error {
	record, exists, err := getMigrationRecord(ctx, conn, migration.name)
	if err != nil {
		return err
	}

	shouldRun := shouldRunMigration(migration, record, exists)
	if !shouldRun {
		log.Printf("INFO: Skipping %s (%s)", migration.name, migration.strategy)
		return nil
	}

	log.Printf("INFO: Running %s (%s)", migration.name, migration.strategy)

	sqlBytes, err := os.ReadFile(migration.path)
	if err != nil {
		return fmt.Errorf("read migration %s: %w", migration.path, err)
	}

	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin transaction for %s: %w", migration.name, err)
	}

	committed := false
	defer func() {
		if !committed {
			if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
				log.Printf("WARN: rollback failed for %s: %v", migration.name, err)
			}
		}
	}()

	if _, err := tx.ExecContext(ctx, string(sqlBytes)); err != nil {
		return fmt.Errorf("execute %s: %w", migration.name, err)
	}

	if err := recordMigration(ctx, tx, migration); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit %s: %w", migration.name, err)
	}

	committed = true
	log.Printf("INFO: Completed %s", migration.name)
	return nil
}

func getMigrationRecord(ctx context.Context, conn *sql.Conn, name string) (migrationRecord, bool, error) {
	var record migrationRecord
	err := conn.QueryRowContext(ctx, "select hash from _migrations where name = $1", name).Scan(&record.hash)
	if errors.Is(err, sql.ErrNoRows) {
		return migrationRecord{}, false, nil
	}
	if err != nil {
		return migrationRecord{}, false, fmt.Errorf("read migration record %s: %w", name, err)
	}

	return record, true, nil
}

func shouldRunMigration(migration migration, record migrationRecord, exists bool) bool {
	switch migration.strategy {
	case strategyRunOnce:
		return !exists
	case strategyHash:
		return !exists || record.hash != migration.hash
	case strategyAlways:
		return true
	default:
		return false
	}
}

func recordMigration(ctx context.Context, tx *sql.Tx, migration migration) error {
	_, err := tx.ExecContext(ctx, `
insert into _migrations (name, strategy, hash, run_count, executed_at)
values ($1, $2, $3, 1, now())
on conflict (name) do update
set strategy = excluded.strategy,
    hash = excluded.hash,
    run_count = _migrations.run_count + 1,
    executed_at = now()`,
		migration.name,
		string(migration.strategy),
		migration.hash,
	)
	if err != nil {
		return fmt.Errorf("record migration %s: %w", migration.name, err)
	}

	return nil
}

func validateDatedMigrationNames(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read migration directory %s: %w", dir, err)
	}

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".sql" {
			continue
		}

		if strings.HasPrefix(entry.Name(), "migration_") && !datedMigrationPattern.MatchString(entry.Name()) {
			return fmt.Errorf("dated migration %s must use migration_YYYY_MM_DD_name.sql", entry.Name())
		}

		if entry.Name() != "better-auth_migrations.sql" &&
			entry.Name() != "schema.sql" &&
			entry.Name() != "functions.sql" &&
			entry.Name() != "rls.sql" &&
			!strings.HasPrefix(entry.Name(), "migration_") {
			return fmt.Errorf("unknown migration file %s", entry.Name())
		}
	}

	return nil
}

// mustEnv returns the value of the environment variable named by the key
// or panics if the key is not set.
func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic(fmt.Sprintf("required env var %s is not set", key))
	}
	return v
}
