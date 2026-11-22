package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Target is one entry of targets.json: a Monitor as its owner would set it
// up. A Monitor is a URL, instructions in plain words and how often to check;
// see the Monitor type in packages/types/src/monitor-config.ts.
type Target struct {
	Name         string `json:"name"`
	URL          string `json:"url"`
	Instructions string `json:"instructions"`
	// IntervalMinutes is how often the Monitor is checked. Without it the
	// Monitor only runs on demand.
	IntervalMinutes *int `json:"interval_minutes"`
}

// SeedMonitors inserts Monitors from targets.json. Every target points at the
// controllable fixtures in apps/sample-pages
// (http://localhost:3003/test/diff/*), never at real sites.
//
// The Monitors have no model connection: their owner picks one in the web
// app. Until then every difference they find is sent as it is.
func SeedMonitors(ctx context.Context, pool *pgxpool.Pool) {
	count := flag.Int("count_monitors", 0, "How many Monitors to seed, going round targets.json; 0 seeds each target once")
	flag.Parse()

	userID := ensureUser(ctx, pool)

	data, err := os.ReadFile("targets.json")
	if err != nil {
		log.Fatalf("Failed to read targets.json: %v", err)
	}

	var targets []Target
	if err := json.Unmarshal(data, &targets); err != nil {
		log.Fatalf("Failed to parse targets.json: %v", err)
	}
	if len(targets) == 0 {
		log.Fatal("targets.json has no targets")
	}

	total := *count
	if total <= 0 {
		total = len(targets)
	}

	log.Printf("Seeding %d monitors from targets.json...", total)
	inserted := 0
	for i := range total {
		target := targets[i%len(targets)]
		name := target.Name
		if round := i/len(targets) + 1; round > 1 {
			name = fmt.Sprintf("%s #%d", name, round)
		}
		_, err := pool.Exec(ctx, `
			INSERT INTO monitors (user_id, name, url, instructions, interval_minutes, status)
			VALUES ($1, $2, $3, $4, $5, 'active')
		`, userID, name, target.URL, target.Instructions, target.IntervalMinutes)
		if err != nil {
			log.Printf("Failed to insert monitor %d: %v", i+1, err)
			continue
		}
		inserted++
	}

	log.Printf("Successfully seeded %d out of %d monitors!", inserted, total)
}

// ensureUser returns the first user, creating a verified test user when the
// database has none.
func ensureUser(ctx context.Context, pool *pgxpool.Pool) string {
	var userID string
	if err := pool.QueryRow(ctx, "SELECT id FROM users LIMIT 1").Scan(&userID); err == nil {
		log.Printf("Using existing user with ID: %s", userID)
		return userID
	}

	log.Println("No users found in database. Creating a default test user...")
	userID = "test-seeder-user"
	_, err := pool.Exec(ctx, `
		INSERT INTO users (id, name, email, email_verified)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO NOTHING
	`, userID, "Test Seeder User", "testuser@wts.sammaji.com", true)
	if err != nil {
		log.Fatalf("Failed to create default test user: %v", err)
	}
	log.Printf("Created default user with ID: %s", userID)
	return userID
}
