module github.com/sammaji/watchthatsite/services/notifications

go 1.26.2

replace github.com/sammaji/watchthatsite/services/core => ../core

require (
	github.com/Azure/go-amqp v1.6.0
	github.com/bytedance/sonic v1.15.1
	github.com/rabbitmq/rabbitmq-amqp-go-client v1.1.0
	github.com/resend/resend-go/v2 v2.28.0
	github.com/sammaji/watchthatsite/services/core v0.0.0
)

require (
	github.com/bytedance/gopkg v0.1.4 // indirect
	github.com/bytedance/sonic/loader v0.5.1 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/cloudwego/base64x v0.1.6 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/gorilla/websocket v1.5.3 // indirect
	github.com/klauspost/cpuid/v2 v2.3.0 // indirect
	github.com/twitchyliquid64/golang-asm v0.15.1 // indirect
	go.opentelemetry.io/otel v1.43.0 // indirect
	go.opentelemetry.io/otel/metric v1.43.0 // indirect
	golang.org/x/arch v0.26.0 // indirect
	golang.org/x/sys v0.46.0 // indirect
)
