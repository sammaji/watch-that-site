package main

import (
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/buaazp/fasthttprouter"
	"github.com/valyala/fasthttp"
)

func newHandler() fasthttp.RequestHandler {
	r := fasthttprouter.New()
	r.NotFound = notFoundHandler
	r.GET("/health", healthHandler)

	for _, m := range []string{"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"} {
		r.Handle(m, apiProxyPrefix+"/:scheme/:host", proxyHandler)
		r.Handle(m, apiProxyPrefix+"/:scheme/:host/*path", proxyHandler)
	}

	return recoveryMiddleware(loggingMiddleware(authMiddleware(r.Handler)))
}

func main() {
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}

	server := &fasthttp.Server{
		Handler:                       newHandler(),
		Name:                          "fasthttp-server",
		ReadTimeout:                   10 * time.Second,
		WriteTimeout:                  10 * time.Second,
		IdleTimeout:                   60 * time.Second,
		MaxRequestBodySize:            4 * 1024 * 1024, // 4 MB
		Concurrency:                   256 * 1024,      // max simultaneous connections
		DisableKeepalive:              false,
		TCPKeepalive:                  true,
		TCPKeepalivePeriod:            30 * time.Second,
		ReduceMemoryUsage:             false,
		DisableHeaderNamesNormalizing: false, // since we passthrough hedears
		NoDefaultServerHeader:         true,
		NoDefaultDate:                 false,
		NoDefaultContentType:          false,
	}

	// graceful shutdown on SIGINT / SIGTERM.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		slog.Info("started proxy server", "port", addr)
		if err := server.ListenAndServe(addr); err != nil {
			slog.Error("server error", "msg", err)
		}
	}()

	<-quit
	slog.Info("shutting down proxy server")
	if err := server.Shutdown(); err != nil {
		slog.Error("shutdown error", "msg", err)
	}
	slog.Info("bye")
}
