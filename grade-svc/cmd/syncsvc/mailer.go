// 邮件发送抽象：生产用阿里云 DirectMail（邮件推送）API，本地/未配置时用 no-op。
// 只做「发一封纯文本 + HTML」；令牌签发、链接、限流都在 auth_mail.go，Mailer 不碰数据库。
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"

	openapi "github.com/alibabacloud-go/darabonba-openapi/v2/utils"
	dm "github.com/alibabacloud-go/dm-20151123/v2/client"
)

var errMailDisabled = errors.New("mail disabled")

type Mailer interface {
	Enabled() bool
	Send(ctx context.Context, to, subject, text, html string) error
}

type noopMailer struct{}

func (noopMailer) Enabled() bool { return false }
func (noopMailer) Send(context.Context, string, string, string, string) error {
	return errMailDisabled
}

type aliyunMailer struct {
	client  *dm.Client
	from    string
	alias   string
	replyTo bool
}

// newMailerFromEnv：MAIL_DRIVER=aliyun 时要求 AccessKey 与发件地址齐全，否则降级 no-op 并打印告警。
// 配置项：
//
//	MAIL_DRIVER=aliyun
//	ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET
//	ALIYUN_DM_ACCOUNT_NAME（控制台已认证的发件地址）
//	ALIYUN_DM_FROM_ALIAS（可选，显示名）
//	ALIYUN_DM_ENDPOINT（可选，默认 dm.aliyuncs.com）
//	ALIYUN_DM_REGION（可选）
func newMailerFromEnv() Mailer {
	driver := strings.ToLower(strings.TrimSpace(os.Getenv("MAIL_DRIVER")))
	if driver == "" || driver == "none" {
		return noopMailer{}
	}
	if driver != "aliyun" {
		log.Printf("⚠ 未知 MAIL_DRIVER=%q，邮件功能关闭", driver)
		return noopMailer{}
	}
	id := strings.TrimSpace(os.Getenv("ALIYUN_ACCESS_KEY_ID"))
	secret := strings.TrimSpace(os.Getenv("ALIYUN_ACCESS_KEY_SECRET"))
	from := strings.TrimSpace(os.Getenv("ALIYUN_DM_ACCOUNT_NAME"))
	if id == "" || secret == "" || from == "" {
		log.Printf("⚠ MAIL_DRIVER=aliyun 但 ALIYUN_ACCESS_KEY_ID/SECRET/ALIYUN_DM_ACCOUNT_NAME 不完整，邮件功能关闭")
		return noopMailer{}
	}
	endpoint := strings.TrimSpace(os.Getenv("ALIYUN_DM_ENDPOINT"))
	if endpoint == "" {
		endpoint = "dm.aliyuncs.com"
	}
	connectTimeout, readTimeout := 5, 10
	cfg := &openapi.Config{
		AccessKeyId:     &id,
		AccessKeySecret: &secret,
		Endpoint:        &endpoint,
		ConnectTimeout:  &connectTimeout,
		ReadTimeout:     &readTimeout,
	}
	if region := strings.TrimSpace(os.Getenv("ALIYUN_DM_REGION")); region != "" {
		cfg.RegionId = &region
	}
	c, err := dm.NewClient(cfg)
	if err != nil {
		log.Printf("⚠ 阿里云 DirectMail 客户端初始化失败：%v，邮件功能关闭", err)
		return noopMailer{}
	}
	alias := strings.TrimSpace(os.Getenv("ALIYUN_DM_FROM_ALIAS"))
	if alias == "" {
		alias = "自考押题站"
	}
	return &aliyunMailer{client: c, from: from, alias: alias}
}

func (m *aliyunMailer) Enabled() bool { return true }

func (m *aliyunMailer) Send(ctx context.Context, to, subject, text, html string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	addressType := int32(1) // 1 = 控制台配置的发件地址
	req := &dm.SingleSendMailRequest{
		AccountName:    &m.from,
		AddressType:    &addressType,
		ReplyToAddress: &m.replyTo,
		ToAddress:      &to,
		Subject:        &subject,
		TextBody:       &text,
		HtmlBody:       &html,
		FromAlias:      &m.alias,
	}
	res, err := m.client.SingleSendMail(req)
	if err != nil {
		return fmt.Errorf("阿里云 DirectMail：%w", err)
	}
	if res != nil && res.StatusCode != nil && (*res.StatusCode < 200 || *res.StatusCode >= 300) {
		return fmt.Errorf("阿里云 DirectMail 状态码 %d", *res.StatusCode)
	}
	return nil
}