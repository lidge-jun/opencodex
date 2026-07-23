package oauth

import "context"

type BrowserFlow interface {
	OAuthFlow
	CallbackOptions() CallbackOptions
}

// RunBrowserLogin coordinates one provider flow with the shared callback server.
func RunBrowserLogin(ctx context.Context, flow BrowserFlow, onAuth func(Authorization), manual ManualCodeFunc) (OAuthCredentials, error) {
	callback, err := StartCallbackServer(flow.CallbackOptions())
	if err != nil {
		return OAuthCredentials{}, err
	}
	defer callback.Close()
	authorization, err := flow.AuthorizationURL(ctx, callback.State, callback.RedirectURI)
	if err != nil {
		return OAuthCredentials{}, err
	}
	if onAuth != nil {
		onAuth(authorization)
	}
	result, err := callback.Wait(ctx, manual)
	if err != nil {
		return OAuthCredentials{}, err
	}
	return flow.Exchange(ctx, result.Code, callback.State, callback.RedirectURI)
}
