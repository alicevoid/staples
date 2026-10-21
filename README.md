# staples

pharika's Kubernetes workloads, reconciled continuously by ArgoCD from this repo.

Sibling to [sutures](https://github.com/alicevoid/sutures): sutures is the NixOS config for the
machine and the cluster substrate; staples is everything running on top. One owner per resource,
no overlap:

```
source of truth      reconciler       owns
sutures (nix)        nixos-rebuild    the box, k3s, Cilium + Gateway API CRDs, the Argo bootstrap
staples (this repo)  ArgoCD           every app, chart, and route in the cluster
```

## Layout

Workloads are grouped `<purpose>/<tool>/<component>.yaml`. The Argo Application objects live in
`apps/`, each pointing at a tool directory:

```
bootstrap/root.yaml   root app-of-apps -> apps/ (also declared in sutures argocd.nix, which applies it)
apps/                 one Argo Application per workload
auth/
  authelia/           namespace, pvcs, configmap, deployment, service, redis
monitoring/
  kube-prometheus-stack/  loki/  alloy/   Helm apps (upstream chart + values.yaml here)
default/
  memos/  karakeep/   user-facing apps (hand-written plain YAML)
  obsidian-livesync/  CouchDB (placeholder + mindvirus vaults) + livesync-bridge, which
                      materializes mindvirus -> /srv/vaults/mindvirus on pharika (for Claude)
security/
  cert-manager/  porkbun-webhook/   Helm apps (DNS-01 via Porkbun for the wildcard cert)
  issuers/            Let's Encrypt staging + prod ClusterIssuers
gateway/
  namespace.yaml  certificate.yaml   pvc.tools + *.pvc.tools cert, consumed by the Gateway
  gateway.yaml        Cilium Gateway: :80 (redirect only) and :443 (*.pvc.tools)
  redirect.yaml       http -> https
  authelia-referencegrant.yaml   lets app routes call Authelia's ext-authz
  routes/             one HTTPRoute per app, created in the app's own namespace
```

`default/` is the catch-all for user-facing apps. All routing lives in `gateway/`: one Cilium
Gateway in host-network mode (Envoy listens on pharika's :80 and :443) and one HTTPRoute per app.
Gated routes use the Gateway API `ExternalAuth` filter against Authelia's ext-authz endpoint; this
needs the experimental Gateway API CRDs, which sutures installs. Routes in other namespaces may call
Authelia because of the ReferenceGrant in `authelia`.

Third-party software is consumed as Argo Helm apps (multi-source: upstream chart + a `values.yaml`
here through `$values`): kube-prometheus-stack, loki, alloy, cert-manager and the Porkbun webhook.
The rule: use a third-party chart through Helm and tune it through values, never by hand-editing
rendered output; write first-party apps (memos, karakeep, authelia, obsidian-livesync) as plain
YAML. Charts that ship large CRDs (kube-prometheus-stack, cert-manager) set `ServerSideApply=true`,
because their CRDs exceed the client-side annotation limit. Each Helm app pins `helm.releaseName`
so Argo adopts the running release instead of duplicating it. Bump a chart by changing
`targetRevision` in its `apps/` Application.

## Secrets

Public-safe repo: zero secrets in git. These Secrets are hand-created in-cluster and referenced by
name only. Argo never touches the Secret objects, so a sync or prune won't delete them.

| Secret | namespace | used by |
| --- | --- | --- |
| `authelia-secrets` | authelia | `/secrets` mount: oidc.yml, users_database.yml, session/jwt/storage keys, smtp password |
| `karakeep-secrets` | karakeep | karakeep + meilisearch (nextauth-secret, meili-master-key, oauth-client-secret) |
| `grafana-admin` | monitoring | kube-prometheus-stack Grafana admin (admin-user, admin-password) |
| `grafana-oauth` | monitoring | Grafana OIDC client-secret |
| `couchdb-secrets` | obsidian | CouchDB admin (username, password) for Obsidian LiveSync; also used by livesync-bridge |
| `argocd-oidc` | argocd | ArgoCD OIDC client-secret (needs label `app.kubernetes.io/part-of=argocd`) |
| `porkbun-api-credentials` | cert-manager | Porkbun DNS-01 webhook (api-key, secret-key) |
| `livesync-bridge-config` | obsidian | livesync-bridge `config.json` (couchdb peer creds + mindvirus<->/srv/vaults storage peer) |

Encrypting secrets into git (sops-nix / agenix) is a later level-up.

## How it reconciles

The root app-of-apps watches `apps/` and creates one child Application per workload. Every app
runs auto-sync with self-heal and prune on, so the cluster tracks git automatically; the root
itself has prune off, so removing an app file does not auto-delete its child.

Adding an app: drop a `<purpose>/<tool>/` directory of manifests plus an `apps/<name>.yaml`
Application pointing at it, then push. Root picks it up within a minute.

## Operating notes

The argocd CLI runs on pharika. Use `--core` (talks to the k8s API directly, no server login).
It needs the kube context namespace set to `argocd`, which sutures' home-manager sets up
automatically on pharika (a private `~/.kube/config` with `KUBECONFIG` pointed at it), so a fresh
shell just works. On any other machine, replicate it once:

```
install -Dm600 /etc/rancher/k3s/k3s.yaml ~/.kube/config
export KUBECONFIG=$HOME/.kube/config
kubectl config set-context --current --namespace=argocd
```

- `argocd app diff <app> --core` before a manual sync shows what would change.
- Health-check an app by curling `*.pvc.tools` directly. pharika resolves those to its own
  tailnet IP through Tailscale split DNS (see sutures `hosts/pharika/configuration.nix`), so there
  is no hairpin from the node. Gated apps answer 302 without a session.
- Debug routing through status: `kubectl describe gateway pvc-tools -n gateway` and
  `kubectl describe httproute <app> -n <ns>` (look for `Accepted` and `ResolvedRefs`).
- The Argo UI is at `argocd.pvc.tools` (Authelia-gated), or use `--core` from the CLI.
- Helm apps must pin `helm.releaseName` to the live release
  name. Argo defaults the release name to the Application name; if it differs, Argo installs a
  parallel stack instead of adopting.

## Known follow-ups

- `traefik-porkbun` (kube-system) is unused after the cutover and can be deleted.
- obsidian.pvc.tools lost its Traefik rate limit; re-add as a CiliumEnvoyConfig `local_ratelimit`.
