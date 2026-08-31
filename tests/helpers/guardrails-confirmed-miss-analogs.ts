export interface GuardrailsConfirmedMissAnalog {
  input: string;
  placeholderType: string;
  ruleId: string;
  value: string;
}

const apiKey = (sequence: number): string => `SyntheticApiKey_${sequence}_Qp7vLm42`;
const password = (sequence: number): string => `SyntheticPass${sequence}#Qx`;
const privateKey = (sequence: number): string => `${`Ab${sequence}+`.repeat(10)}Ab${sequence}=`;

export const GUARDRAILS_CONFIRMED_MISS_ANALOGS: readonly GuardrailsConfirmedMissAnalog[] = [
  {
    input: `OPENROUTER_API_KEY="${apiKey(1)}"`,
    value: apiKey(1),
    ruleId: "opencodex.api-keys.assignment",
    placeholderType: "OPENCODEX_API_KEY",
  },
  {
    input: `SKIPCAP_API_KEY:\n  ${apiKey(2)}`,
    value: apiKey(2),
    ruleId: "opencodex.api-keys.assignment",
    placeholderType: "OPENCODEX_API_KEY",
  },
  ...[
    (value: string) => `PASSWORD=${value}`,
    (value: string) => `password: ${value}`,
    (value: string) => `пароль: ${value}`,
    (value: string) => `DB_PASSWORD='${value}'`,
    (value: string) => `- \`ADMIN_PASSWORD=${value}\``,
    (value: string) => `passwd="${value}"`,
    (value: string) => `pwd: ${value}`,
    (value: string) => `REDIS_PASSWORD=${value}`,
    (value: string) => `SFTP_PASSWORD=${value}`,
    (value: string) => `PROXY_PASSWORD=${value}`,
    (value: string) => `MYSQL_PASSWORD=${value}`,
    (value: string) => `POSTGRES_PASSWORD=${value}`,
    (value: string) => `SERVICE_PASSWORD: ${value}`,
    (value: string) => `пароль = ${value}`,
    (value: string) => `APP_PASSWD=${value}`,
    (value: string) => `AUTH_PWD=${value}`,
  ].map((format, index) => {
    const value = password(index + 1);
    return {
      input: format(value),
      value,
      ruleId: "opencodex.credentials.password-assignment",
      placeholderType: "OPENCODEX_PASSWORD",
    };
  }),
  {
    input: `- Private key: \`${privateKey(1)}\``,
    value: privateKey(1),
    ruleId: "opencodex.credentials.private-key-assignment",
    placeholderType: "OPENCODEX_PRIVATE_KEY",
  },
  {
    input: `WIREGUARD_PRIVATEKEY=${privateKey(2)}`,
    value: privateKey(2),
    ruleId: "opencodex.credentials.private-key-assignment",
    placeholderType: "OPENCODEX_PRIVATE_KEY",
  },
  {
    input: "BROWSER_JOB_SECRET_KEYS='{\"primary\":\"SyntheticKeyring42Qx\"}'",
    value: "{\"primary\":\"SyntheticKeyring42Qx\"}",
    ruleId: "opencodex.credentials.secret-assignment",
    placeholderType: "OPENCODEX_SECRET",
  },
  {
    input: `- \`HMAC_SIGNING_SECRET=${"9f4a7c2e1d8b6a3f".repeat(4)}\``,
    value: "9f4a7c2e1d8b6a3f".repeat(4),
    ruleId: "opencodex.credentials.secret-assignment",
    placeholderType: "OPENCODEX_SECRET",
  },
  {
    input: `PROXY_URL=socks5h://synthetic-user:${password(17)}@192.0.2.10:1080`,
    value: `socks5h://synthetic-user:${password(17)}@192.0.2.10:1080`,
    ruleId: "opencodex.credentials.infrastructure-uri-userinfo",
    placeholderType: "OPENCODEX_URL_WITH_CREDS",
  },
];

if (GUARDRAILS_CONFIRMED_MISS_ANALOGS.length !== 23) {
  throw new Error("Guardrails confirmed-miss analog inventory must contain exactly 23 cases");
}
