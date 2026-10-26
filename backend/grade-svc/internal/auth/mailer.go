package auth

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
	client *dm.Client
	from   string
	alias  string
}

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
		log.Printf("⚠ MAIL_DRIVER=aliyun 但凭据不完整，邮件功能关闭")
		return noopMailer{}
	}
	endpoint := strings.TrimSpace(os.Getenv("ALIYUN_DM_ENDPOINT"))
	if endpoint == "" {
		endpoint = "dm.aliyuncs.com"
	}
	ct, rt := 5, 10
	cfg := &openapi.Config{AccessKeyId: &id, AccessKeySecret: &secret, Endpoint: &endpoint, ConnectTimeout: &ct, ReadTimeout: &rt}
	if region := strings.TrimSpace(os.Getenv("ALIYUN_DM_REGION")); region != "" {
		cfg.RegionId = &region
	}
	c, err := dm.NewClient(cfg)
	if err != nil {
		log.Printf("⚠ 阿里云 DirectMail 初始化失败：%v", err)
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
	addressType := int32(1)
	reply := false
	req := &dm.SingleSendMailRequest{
		AccountName: &m.from, AddressType: &addressType, ReplyToAddress: &reply,
		ToAddress: &to, Subject: &subject, TextBody: &text, HtmlBody: &html, FromAlias: &m.alias,
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
