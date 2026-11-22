package config

import (
	"fmt"

	"github.com/sammaji/watchthatsite/services/core/utils"
)

type Config struct {
	DatabaseURL string
	RabbitMQURL string
	Email       EmailConfig
	Discord     DiscordConfig
	Telegram    TelegramConfig
}

type RabbitMQConfig struct {
	URL string
}

type EmailConfig struct {
	APIKey   string
	FromAddr string
	FromName string
}

type DiscordConfig struct {
	BotToken string
}

type TelegramConfig struct {
	BotToken string
}

func Load() (*Config, error) {
	postgresDatabase := utils.MustEnv("POSTGRES_DATABASE")
	postgresHost := utils.MustEnv("POSTGRES_HOST")
	postgresPort := utils.MustEnv("POSTGRES_PORT")
	postgresUser := utils.MustEnv("POSTGRES_USER")
	postgresPassword := utils.MustEnv("POSTGRES_PASSWORD")
	databaseUrl := fmt.Sprintf("postgres://%s:%s@%s:%s/%s", postgresUser, postgresPassword, postgresHost, postgresPort, postgresDatabase)

	rabbitmqUser := utils.MustEnv("RABBITMQ_USER")
	rabbitmqPassword := utils.MustEnv("RABBITMQ_PASSWORD")
	rabbitmqHost := utils.MustEnv("RABBITMQ_HOST")
	rabbitmqPort := utils.MustEnv("RABBITMQ_PORT")
	rabbitmqUrl := fmt.Sprintf("amqp://%s:%s@%s:%s/", rabbitmqUser, rabbitmqPassword, rabbitmqHost, rabbitmqPort)

	resentApiKey := utils.MustEnv("RESEND_API_KEY")
	fromAddr := utils.MustEnv("SMTP_MAIL")
	fromName := utils.MustEnv("SMTP_SENDER_NAME")

	discordBotToken := utils.GetEnv("DISCORD_BOT_TOKEN", "")
	telegramBotToken := utils.GetEnv("TELEGRAM_BOT_TOKEN", "")

	return &Config{
		DatabaseURL: databaseUrl,
		RabbitMQURL: rabbitmqUrl,
		Email: EmailConfig{
			APIKey:   resentApiKey,
			FromAddr: fromAddr,
			FromName: fromName,
		},
		Discord: DiscordConfig{
			BotToken: discordBotToken,
		},
		Telegram: TelegramConfig{
			BotToken: telegramBotToken,
		},
	}, nil
}
