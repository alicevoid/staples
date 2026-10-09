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
  kube-prometheus-stack/values.yaml   the one Helm app (operator + CRDs + rules)
  loki/  alloy/  tempo/                plain YAML, rendered once from their charts
default/
  memos/  karakeep/   user-facing apps
  routing/            all IngressRoutes + per-namespace authelia forwardAuth Middlewares
```

`default/` is the catch-all. Routing lives there on purpose: Cilium + Gateway API will eventually
rewrite these Traefik IngressRoutes as HTTPRoutes under a `gateway/` directory, so there's no
point giving them their own top-level category yet. `argocd/` is reserved for Argo's own extras
(a future `argocd.pvc.tools` route, AppProjects); empty for now since the install itself is Nix.

Only kube-prometheus-stack uses Helm (via Argo multi-source: upstream chart + `values.yaml` here
through `$values`). loki/alloy/tempo were rendered once with `helm template` and committed as
plain manifests. Re-render on a version bump rather than hand-editing; the command is in each
file's header.

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

Encrypting secrets into git (sops-nix / agenix) is a later level-up.

## How it reconciles

The root app-of-apps watches `apps/` and creates one child Application per workload. Every app
runs auto-sync with self-heal and prune on, so the cluster tracks git automatically; the root
itself has prune off, so removing an app file does not auto-delete its child.

Adding an app: drop a `<purpose>/<tool>/` directory of manifests plus an `apps/<name>.yaml`
Application pointing at it, then push. Root picks it up within a minute.

## Operating notes

The argocd CLI runs on pharika. Use `--core` (talks to the k8s API directly, no server login).
It needs the kube context namespace set to `argocd`, one-time:

```
install -Dm600 /etc/rancher/k3s/k3s.yaml ~/.kube/config
export KUBECONFIG=$HOME/.kube/config          # add to your shell profile to persist
kubectl config set-context --current --namespace=argocd
```

- `argocd app diff <app> --core` before a manual sync shows what would change.
- Health-check an app via its LoadBalancer on localhost, e.g. `curl -s localhost:5230` (memos),
  `localhost:3000` (karakeep). Do not curl `*.pvc.tools` from pharika itself: the host resolves
  those to the WAN IP and NAT-hairpins, so it always returns 000 from the node. Test from a laptop.
- The Argo UI is reachable over an ssh tunnel (see sutures argocd.nix), or `--core` from the CLI.
- Helm apps (currently just kube-prometheus-stack) MUST pin `helm.releaseName` to the live release
  name. Argo defaults the release name to the Application name; if it differs, Argo installs a
  parallel stack instead of adopting.

## Known follow-ups

- Dormant Nix leftovers: the old k3s addon manifests still sit in
  `/var/lib/rancher/k3s/server/manifests/` on pharika (NixOS does not delete them when a module is
  removed). They are inert while the box stays up, but a k3s restart re-applies them and can briefly
  fight Argo. Clearing them safely (so no PVC is pruned) means, per app: strip the
  `objectset.rio.cattle.io/*` annotations and `objectset.rio.cattle.io/hash` label from the live
  objects, then `sudo rm` the manifest file. The observability HelmChart CRs need their
  helm-controller finalizer removed before deletion or the controller runs `helm uninstall`. Best
  done as a tested script, not by hand.
- `default/homer`: leftover debug deployment (NodePort 30441), not in Nix. `kubectl -n default
  delete deploy/homer svc/homer` and `sudo rm -rf /srv/homer`.
- An `argocd.pvc.tools` IngressRoute under `argocd/` to retire the ssh tunnel.
- Cilium + Gateway API: will replace flannel/klipper/Traefik-IngressRoute. Keep routing isolated
  so the swap is contained.
