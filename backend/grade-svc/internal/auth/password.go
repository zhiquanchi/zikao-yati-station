package auth

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

const (
	defaultPBKDF2Iterations = 600_000
	pbkdf2KeyLen            = 32
	pbkdf2SaltLen           = 16
)

var pbkdf2Iterations = defaultPBKDF2Iterations
var passB64 = base64.RawURLEncoding

func hashPassword(password string) (string, error) {
	salt := make([]byte, pbkdf2SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, pbkdf2Iterations, pbkdf2KeyLen)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s",
		pbkdf2Iterations, passB64.EncodeToString(salt), passB64.EncodeToString(key)), nil
}

func verifyPassword(encoded, password string) (bool, bool) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false, false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 {
		return false, false
	}
	salt, err := passB64.DecodeString(parts[2])
	if err != nil || len(salt) == 0 {
		return false, false
	}
	want, err := passB64.DecodeString(parts[3])
	if err != nil || len(want) == 0 {
		return false, false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, iter, len(want))
	if err != nil {
		return false, false
	}
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return false, false
	}
	return true, iter < pbkdf2Iterations
}

func validatePassword(p string) bool { return len(p) >= 8 && len(p) <= 128 }
