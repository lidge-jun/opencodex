import { DefaultAzureCredential } from "@azure/identity";

const AZURE_OPENAI_SCOPE = "https://cognitiveservices.azure.com/.default";

let credential: DefaultAzureCredential | undefined;

function getCredential(): DefaultAzureCredential {
  return credential ??= new DefaultAzureCredential();
}

export async function getAzureOpenAiAccessToken(): Promise<string | undefined> {
  return (await getCredential().getToken(AZURE_OPENAI_SCOPE))?.token;
}
