// Shared Connect client + transport. One instance per app.
//
// Transport uses the default `fetch` under the hood. `credentials: "include"`
// is essential: without it the browser drops the session cookie on Connect
// calls, and every Whoami after Claim would return empty.

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { AuthService } from "../gen/gitchat/v1/auth_pb.js";
import { RepoService } from "../gen/gitchat/v1/repo_pb.js";
import { ChatService } from "../gen/gitchat/v1/chat_pb.js";

const transport = createConnectTransport({
  baseUrl: "/",
  useBinaryFormat: false,
  fetch: (input, init) =>
    fetch(input, { ...init, credentials: "include" }),
});

export const authClient = createClient(AuthService, transport);
export const repoClient = createClient(RepoService, transport);
export const chatClient = createClient(ChatService, transport);
