// Command r2ctl exercises the r2 package from a shell, for manual checks
// against a real bucket, a local MinIO, or the object-store Worker.
//
// It picks its Store like r2.NewStoreFromEnv: S3 credentials when
// R2_ACCESS_KEY_ID is set, otherwise the Worker at R2_WORKER_URL.
//
//	r2ctl put  <key> <file>          upload a file
//	r2ctl get  <key> <file>          download to a file ("-" for stdout)
//	r2ctl rm   <key> [key...]        delete objects
//	r2ctl sign <key> [ttl]           print a signed Worker URL (default 5m)
//	r2ctl head <key>                 print metadata (S3 mode only)
//	r2ctl ls   <prefix>              list objects (S3 mode only)
//	r2ctl key  <kind> <ids...>       build a key
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/sammaji/watchthatsite/packages/cloudflare_go/r2"
)

const usage = `r2ctl — manual client for the watchthatsite object store

usage:
  r2ctl put  <key> <file>                 upload a file (content type from the key)
  r2ctl get  <key> <file>                 download to a file ("-" for stdout)
  r2ctl rm   <key> [key...]               delete objects
  r2ctl sign <key> [ttl]                  print a signed Worker URL (ttl default 5m)
  r2ctl head <key>                        print metadata (S3 mode only)
  r2ctl ls   <prefix>                     list objects (S3 mode only)
  r2ctl key  shot   <monitor> <run> [png|webp]
  r2ctl key  learn  <monitor> <run> <0|1|2> [png|webp]
  r2ctl key  blocks <monitor> <run>
  r2ctl key  change|diff|crop <monitor> <change>
  r2ctl key  state  <monitor>

environment (see r2.NewStoreFromEnv):
  S3 mode:      R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
                R2_ACCOUNT_ID or R2_ENDPOINT, R2_USE_PATH_STYLE (MinIO)
  Worker mode:  R2_WORKER_URL, R2_API_TOKEN (no R2_ACCESS_KEY_ID)
  sign:         R2_WORKER_URL, R2_SIGNING_SECRET
`

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "r2ctl:", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		return errors.New("no command given")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	command, args := os.Args[1], os.Args[2:]

	switch command {
	case "key":
		return buildKey(args)
	case "help", "-h", "--help":
		fmt.Print(usage)
		return nil
	}

	store, err := r2.NewStoreFromEnv(ctx)
	if err != nil {
		return err
	}

	switch command {
	case "put":
		return put(ctx, store, args)
	case "get":
		return get(ctx, store, args)
	case "rm":
		return remove(ctx, store, args)
	case "sign":
		return sign(store, args)
	case "head":
		return head(ctx, s3Only(store), args)
	case "ls":
		return list(ctx, s3Only(store), args)
	default:
		fmt.Fprint(os.Stderr, usage)
		return fmt.Errorf("unknown command %q", command)
	}
}

func s3Only(store r2.Store) *r2.Client {
	client, _ := store.(*r2.Client)
	return client
}

func put(ctx context.Context, store r2.Store, args []string) error {
	if len(args) != 2 {
		return errors.New("usage: r2ctl put <key> <file>")
	}
	data, err := os.ReadFile(args[1])
	if err != nil {
		return err
	}
	if err := store.Put(ctx, args[0], data, ""); err != nil {
		return err
	}
	fmt.Printf("uploaded %s (%d bytes, %s)\n", args[0], len(data), r2.ContentTypeForKey(args[0]))
	return nil
}

func get(ctx context.Context, store r2.Store, args []string) error {
	if len(args) != 2 {
		return errors.New("usage: r2ctl get <key> <file>")
	}
	data, err := store.Get(ctx, args[0])
	if err != nil {
		return err
	}
	if args[1] == "-" {
		_, err := os.Stdout.Write(data)
		return err
	}
	if err := os.WriteFile(args[1], data, 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote %s (%d bytes) to %s\n", args[0], len(data), args[1])
	return nil
}

func remove(ctx context.Context, store r2.Store, args []string) error {
	if len(args) == 0 {
		return errors.New("usage: r2ctl rm <key> [key...]")
	}
	for _, key := range args {
		if err := store.Delete(ctx, key); err != nil {
			return err
		}
	}
	fmt.Printf("deleted %d object(s)\n", len(args))
	return nil
}

func sign(store r2.Store, args []string) error {
	if len(args) < 1 || len(args) > 2 {
		return errors.New("usage: r2ctl sign <key> [ttl]")
	}
	ttl := 5 * time.Minute
	if len(args) == 2 {
		parsed, err := time.ParseDuration(args[1])
		if err != nil {
			return err
		}
		ttl = parsed
	}
	url, err := store.SignedURL(args[0], ttl)
	if err != nil {
		return err
	}
	fmt.Println(url)
	return nil
}

func head(ctx context.Context, client *r2.Client, args []string) error {
	if client == nil {
		return errors.New("head needs S3 credentials (R2_ACCESS_KEY_ID)")
	}
	if len(args) != 1 {
		return errors.New("usage: r2ctl head <key>")
	}
	obj, err := client.Head(ctx, args[0])
	if err != nil {
		return err
	}
	writer := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintf(writer, "key\t%s\n", obj.Key)
	fmt.Fprintf(writer, "size\t%d\n", obj.Size)
	fmt.Fprintf(writer, "etag\t%s\n", obj.ETag)
	fmt.Fprintf(writer, "content-type\t%s\n", obj.ContentType)
	fmt.Fprintf(writer, "last-modified\t%s\n", obj.LastModified.Format(time.RFC3339))
	return writer.Flush()
}

func list(ctx context.Context, client *r2.Client, args []string) error {
	if client == nil {
		return errors.New("ls needs S3 credentials (R2_ACCESS_KEY_ID)")
	}
	if len(args) != 1 {
		return errors.New("usage: r2ctl ls <prefix>")
	}
	objects, err := client.ListAll(ctx, args[0])
	if err != nil {
		return err
	}
	if len(objects) == 0 {
		fmt.Printf("no objects under %q\n", args[0])
		return nil
	}
	writer := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	for _, obj := range objects {
		fmt.Fprintf(writer, "%d\t%s\t%s\n", obj.Size, obj.LastModified.Format("2006-01-02T15:04:05Z"), obj.Key)
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	fmt.Printf("%d object(s)\n", len(objects))
	return nil
}

func buildKey(args []string) error {
	if len(args) < 2 {
		return errors.New("usage: r2ctl key <shot|learn|blocks|change|diff|crop|state> <ids...>")
	}
	kind, ids := args[0], args[1:]
	arg := func(i int, fallback string) string {
		if i < len(ids) {
			return ids[i]
		}
		return fallback
	}
	var (
		key string
		err error
	)
	switch kind {
	case "shot":
		key, err = r2.CaptureShotKey(arg(0, ""), arg(1, ""), arg(2, r2.FormatPNG))
	case "learn":
		index, convErr := strconv.Atoi(arg(2, ""))
		if convErr != nil {
			return errors.New("usage: r2ctl key learn <monitor> <run> <0|1|2> [png|webp]")
		}
		key, err = r2.LearnShotKey(arg(0, ""), arg(1, ""), index, arg(3, r2.FormatPNG))
	case "blocks":
		key, err = r2.BlocksKey(arg(0, ""), arg(1, ""))
	case "change":
		key, err = r2.ChangeRecordKey(arg(0, ""), arg(1, ""))
	case "diff":
		key, err = r2.ChangeDiffKey(arg(0, ""), arg(1, ""))
	case "crop":
		key, err = r2.ChangeCropKey(arg(0, ""), arg(1, ""))
	case "state":
		key, err = r2.StorageStateKey(arg(0, ""))
	default:
		return fmt.Errorf("unknown key kind %q", kind)
	}
	if err != nil {
		return err
	}
	fmt.Println(key)
	return nil
}
