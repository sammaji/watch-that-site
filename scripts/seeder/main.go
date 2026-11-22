package main

import (
	"context"
	"log"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sammaji/watchthatsite/services/core/config"
)

func main() {

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config load failed: %v", err)
	}

	log.Println("Connecting to database...")
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Unable to connect to database: %v", err)
	}

	defer pool.Close()

	SeedMonitors(ctx, pool)

}

// func loadEnv() {
// 	dir, err := os.Getwd()
// 	if err != nil {
// 		return
// 	}
// 	for {
// 		envPath := filepath.Join(dir, ".env")
// 		if _, err := os.Stat(envPath); err == nil {
// 			_ = godotenv.Load(envPath)
// 			return
// 		}
// 		parent := filepath.Dir(dir)
// 		if parent == dir {
// 			break
// 		}
// 		dir = parent
// 	}
// }
