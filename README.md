# staples

pharika's Kubernetes workloads, reconciled continuously by ArgoCD from this repo.

Sibling to [sutures](https://github.com/alicevoid/sutures): sutures is the NixOS config for the
machine and the cluster substrate; staples is everything running on top. One owner per resource,
no overlap:

```
source of truth      reconciler       owns
sutures (nix)        nixos-rebuild    the box, k3s, the Traefik controller, the Argo bootstrap
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
  routing/            all IngressRoutes + per-namespace authelia forwardAuth Middlewares
argocd/
  route.yaml          argocd.pvc.tools IngressRoute + Authelia Middleware
```

`default/` is the catch-all. Routing lives there on purpose: Cilium + Gateway API will eventually
rewrite these Traefik IngressRoutes as HTTPRoutes under a `gateway/` directory, so there's no
point giving them their own top-level category yet. `argocd/` holds Argo's own extras — currently
the `argocd.pvc.tools` route (IngressRoute + Authelia Middleware, admins only); the Argo install
itself stays in Nix.

The observability charts are Argo Helm apps (multi-source: upstream chart + a `values.yaml` here
through `$values`): kube-prometheus-stack, loki, alloy. The rule: consume a third-party chart via
Helm and tune it through values — never hand-edit rendered output; write first-party apps (memos,
karakeep, authelia) as plain YAML. kube-prometheus-stack additionally sets `ServerSideApply=true`
(its operator CRDs exceed the client-side annotation limit); the others ship no CRDs, so they
don't need it. Each Helm app pins `helm.releaseName` to the live release so Argo adopts the
running workload instead of duplicating it. Bump a chart by changing `targetRevision` in its
`apps/` Application.

## Secrets

Public-safe repo: zero secrets in git. Five Secrets are hand-created in-cluster and referenced by
name only. Argo never touches the Secret objects, so a sync or prune won't delete them.

| Secret | namespace | used by |
| --- | --- | --- |
| `authelia-secrets` | authelia | `/secrets` mount: oidc.yml, users_database.yml, session/jwt/storage keys, smtp password |
| `karakeep-secrets` | karakeep | karakeep + meilisearch (nextauth-secret, meili-master-key, oauth-client-secret) |
| `grafana-admin` | monitoring | kube-prometheus-stack Grafana admin (admin-user, admin-password) |
| `grafana-oauth` | monitoring | Grafana OIDC client-secret |
| `traefik-porkbun` | kube-system | Traefik DNS-01 ACME (api-key, secret-api-key); lives with the Traefik controller in Nix |
| `couchdb-secrets` | obsidian | CouchDB admin (username, password) for Obsidian LiveSync; also used by livesync-bridge |
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
- Health-check an app via its LoadBalancer on localhost, e.g. `curl -s localhost:5230` (memos),
  `localhost:3000` (karakeep), or curl `*.pvc.tools` directly. pharika resolves those to its own
  tailnet IP through Tailscale split DNS (see sutures `hosts/pharika/configuration.nix`), so there
  is no hairpin from the node.
- The Argo UI is at `argocd.pvc.tools` (Authelia-gated), or use `--core` from the CLI.
- Helm apps (currently just kube-prometheus-stack) MUST pin `helm.releaseName` to the live release
  name. Argo defaults the release name to the Application name; if it differs, Argo installs a
  parallel stack instead of adopting.

## Known follow-ups

- Cilium + Gateway API: will replace flannel/klipper/Traefik-IngressRoute. Keep routing isolated
  so the swap is contained.
