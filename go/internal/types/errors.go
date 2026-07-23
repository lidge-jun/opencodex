package types

import "fmt"

type BaseError struct {
	Code       string
	Message    string
	StatusCode int
	Retryable  bool
	Cause      error
}

func (e BaseError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

func (e BaseError) Unwrap() error { return e.Cause }

type AuthError struct{ BaseError }
type ProviderError struct {
	BaseError
	Provider string
}
type RateLimitError struct {
	BaseError
	RetryMeta *RetryMeta
}
type ConfigError struct {
	BaseError
	Field string
}
type ValidationError struct {
	BaseError
	Field string
}
type PermissionError struct{ BaseError }
type TimeoutError struct{ BaseError }

func NewAuthError(message string, cause error) *AuthError {
	return &AuthError{BaseError{Code: "invalid_api_key", Message: message, StatusCode: 401, Cause: cause}}
}

func NewProviderError(provider, message string, status int, cause error) *ProviderError {
	return &ProviderError{BaseError: BaseError{Code: "provider_error", Message: message, StatusCode: status, Cause: cause}, Provider: provider}
}

func NewRateLimitError(message string, meta *RetryMeta) *RateLimitError {
	return &RateLimitError{BaseError: BaseError{Code: "rate_limit_exceeded", Message: message, StatusCode: 429, Retryable: true}, RetryMeta: meta}
}

func NewConfigError(field, message string, cause error) *ConfigError {
	return &ConfigError{BaseError: BaseError{Code: "invalid_config", Message: fmt.Sprintf("%s: %s", field, message), StatusCode: 500, Cause: cause}, Field: field}
}

func NewValidationError(field, message string) *ValidationError {
	return &ValidationError{BaseError: BaseError{Code: "invalid_request", Message: fmt.Sprintf("%s: %s", field, message), StatusCode: 400}, Field: field}
}
