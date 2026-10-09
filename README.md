# 📎 staples — pharika's workloads, continuously deployed by ArgoCD

> Surgical sibling to [`sutures`](https://github.com/alicevoid/sutures): **sutures holds
> the machines together (the cluster substrate, in Nix); `staples` holds the workloads**
> (plain YAML + Helm values, reconciled by Argo). Spec/rationale: the `ARGOCD.md` note.

Argo watches this repo and makes the cluster match it — killing the silent drift the
old `nixos-rebuild` loop allowed (an unchanged manifest was never re-applied; `tempo`
was commented out in Nix yet kept Running). One owner per resource:

```
EDIT            SOURCE OF TRUTH      RECONCILER           OWNS
machine config  sutures (nix)        nixos-rebuild        the box, k3s, Traefik controller, Argo bootstrap
app workloads   staples (this repo)  ArgoCD               every app, chart, and route in-cluster
```

## Layout

```
bootstrap/root.yaml   root app-of-apps -> apps/  (mirrors sutures' argocd.nix; that addon applies it)
apps/                 one Argo Application per workload (sync-wave ordered)
manifests/            plain k8s YAML: whoami, memos, karakeep, authelia (+redis), routing
charts/               Helm values: kube-prometheus-stack, loki, alloy, tempo
```

`apps/` → `manifests/` (directory Applications) and `charts/` (Helm multi-source: chart from
the upstream repo, `values.yaml` from here via `$values`). Routing (IngressRoutes + the
per-namespace Authelia forwardAuth Middlewares) is isolated in `manifests/routing/` so a
future Cilium / Gateway-API swap touches one directory.

## Secrets — none live here (public-safe repo)

Five Secrets stay **hand-created in-cluster**, out of git; manifests reference them by name
and Argo never touches the Secret objects. Don't let migration delete them (they aren't
Addon-owned, so a Nix prune won't).

| Secret | ns | consumed by |
| --- | --- | --- |
| `authelia-secrets` | authelia | `/secrets` mount: `oidc.yml`, `users_database.yml`, session/jwt/storage keys, smtp password |
| `karakeep-secrets` | karakeep | karakeep + meilisearch (`nextauth-secret`, `meili-master-key`, `oauth-client-secret`) |
| `grafana-admin` | monitoring | kube-prometheus-stack Grafana admin (`admin-user`, `admin-password`) |
| `grafana-oauth` | monitoring | Grafana OIDC `client-secret` |
| `traefik-porkbun` | kube-system | Traefik DNS-01 ACME (`api-key`, `secret-api-key`) — lives with the Traefik controller in Nix |

> Encrypting secrets into git (SOPS / sops-nix / agenix) is a later level-up, not now.

## Sync posture

- **Root** (`bootstrap/root.yaml`) auto-syncs with **prune off** — adding/removing a file in
  `apps/` propagates to the child Application objects; a removed file never auto-deletes one.
- **Every child** is **manual sync + `prune: false`** during the migration: Argo *adopts* the
  live objects and changes nothing without `argocd app sync <app>`. Turn on continuous
  reconcile per app (uncomment the `automated:` block) only after you've verified it.
- Child Applications carry **no cascade finalizer**, so deleting an Application never deletes
  its PVCs/data. Add `resources-finalizer.argocd.argoproj.io` later if you want full
  app-lifecycle GitOps.
- `observability-kps` sets **`ServerSideApply=true`** (prometheus-operator CRDs exceed the
  client-side annotation-size limit).

---

# 🚑 Cutover runbook (data-safe; rip the band-aid, most-critical LAST)

Run on pharika (`ssh pharika`) / from a shell with `KUBECONFIG` set. `argocd app diff <app>`
before every sync is the anti-regret button — never sync blind.

### 0 · Prep + backups (do NOT skip)

Every PV is reclaim=`Delete` and Addon-owned, so removing an app from Nix + rebuilding would
cascade **Addon → PVC → PV → on-disk dir erased**. Back up the must-preserve data and flip
those PVs to `Retain` first.

```bash
# Back up the on-disk dirs (dir name = <pv>_<ns>_<claim>):
sudo tar czf /tmp/memos.tgz     -C /var/lib/rancher/k3s/storage pvc-7893d874-26de-45fc-b21f-86790c393b10_memos_memos-data
sudo tar czf /tmp/karakeep.tgz  -C /var/lib/rancher/k3s/storage pvc-c9dc2b71-8376-4475-97e7-3e931d886a12_karakeep_karakeep-data
sudo tar czf /tmp/authelia.tgz  -C /var/lib/rancher/k3s/storage pvc-932d57f2-dfcd-4dda-a4aa-d25fca6c792d_authelia_authelia-data
sudo tar czf /tmp/grafana.tgz   -C /var/lib/rancher/k3s/storage pvc-75f1dbb2-f9c1-491e-99eb-f1ff7ad3f309_monitoring_kube-prometheus-stack-grafana
# (copy the tarballs somewhere off-box too)

# Flip must-preserve PVs to Retain so a prune can't destroy them:
for pv in \
  pvc-7893d874-26de-45fc-b21f-86790c393b10 \
  pvc-c9dc2b71-8376-4475-97e7-3e931d886a12 \
  pvc-5cdb7439-6bef-4511-82a4-05ae33788b90 \
  pvc-932d57f2-dfcd-4dda-a4aa-d25fca6c792d \
  pvc-a0fbbd44-8f88-4eb1-8bdc-087b89d5b4a8 \
  pvc-75f1dbb2-f9c1-491e-99eb-f1ff7ad3f309 ; do
  kubectl patch pv $pv -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
done

# Publish this repo (Argo syncs from the GitHub remote):
cd ~/staples && git add -A && git commit -m "initial: pharika workloads for ArgoCD" && git push -u origin main
```

PV → PVC map: memos-data `pvc-7893d874…` · karakeep-data `pvc-c9dc2b71…` · meili-data
`pvc-5cdb7439…` · authelia-data `pvc-932d57f2…` · redis-data `pvc-a0fbbd44…` ·
grafana `pvc-75f1dbb2…`.

### 1 · Bootstrap Argo (Nix)

`modules/k8s/argocd.nix` is new and `default.nix` already imports it — **git-add both
together** or the flake build errors (flakes ignore untracked files):

```bash
cd ~/sutures
git add modules/k8s/argocd.nix modules/k8s/default.nix
# argocd.nix has hash = ""; the first rebuild will FAIL and print the real hash —
# paste it into argocd.nix, git add again, and rebuild once more:
sudo nixos-rebuild switch --flake ~/sutures#pharika
kubectl -n argocd rollout status deploy/argocd-server
kubectl -n argocd port-forward svc/argocd-server 8080:443   # UI at https://localhost:8080
# admin password: kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

The root app-of-apps appears and creates every child Application (all OutOfSync/manual).

### 2 · Prove the loop (whoami, zero risk)

```bash
argocd app sync whoami && kubectl -n whoami get pods     # Running = git -> Argo -> cluster works
# then retire it:
git -C ~/staples rm apps/_whoami.yaml -r manifests/whoami && git -C ~/staples commit -m "drop whoami smoke-test" && git -C ~/staples push
argocd app delete whoami --cascade   # safe: no data
```

### 3 · routing — adopt FIRST, with self-heal (prevents a public-route gap)

Each per-app Nix module *embeds* its own IngressRoute + Middleware. So when you later drop
`memos.nix` etc., k3s prunes that module's route too. If Argo didn't already own the routes,
`<app>.pvc.tools` would 404 until the end. Fix: adopt routing up front and turn on self-heal,
so the instant a route is pruned Argo recreates it. Every route object already exists
(Nix-owned), so adoption is a no-op diff; the brief dual-ownership is harmless (identical
content, and Nix only reconciles on rebuild).

```bash
argocd app diff routing      # EXPECT ~nothing (all 5 routes + 4 middlewares already live)
argocd app sync routing
# enable continuous reconcile NOW (uncomment automated: in apps/routing.yaml, commit+push):
argocd app sync routing
# after EVERY rebuild below, re-assert immediately to close the seconds-gap:
#   argocd app sync routing
```

### 4 · memos — the template every stateful app copies

```bash
argocd app diff memos --core   # EXPECT ~nothing but an argocd tracking-id annotation (adoption)
argocd app sync memos --core   # adopt (manual); still Nix-owned too, harmless
# tidy Nix config: drop ./memos.nix from default.nix imports + `git rm modules/k8s/memos.nix`, rebuild.
sudo nixos-rebuild switch --flake ~/sutures#pharika
kubectl -n memos get pod -l app=memos      # SAME pod (old age) = data untouched
curl -s --max-time 3 -o /dev/null -w '%{http_code}\n' http://localhost:5230   # 200 (test via LB, NOT the pvc.tools URL)
# verified? arm continuous reconcile: uncomment automated: in apps/memos.yaml, push, then:
argocd app sync memos --core
```

> [!warning] NixOS does NOT prune the k3s addon on module removal
> `git rm`-ing the module + rebuilding removes it from *config*, but NixOS leaves the on-disk
> `/var/lib/rancher/k3s/server/manifests/<app>.yaml`, so `kubectl get addon -A` still lists it
> and the app stays dual-owned (dormant k3s addon + Argo). This is FINE and actually safer — a
> rebuild alone never prunes/deletes data. **Do not `rm` that file or `kubectl delete addon` now:**
> that's the only thing that prunes the PVC (→ retained-PV rebind). The full Nix release (removing
> the stale on-disk manifests, carefully so no PVC is pruned) is deferred to step 8.
> Caveat: a dormant addon re-asserts its frozen spec on a k3s **restart/reboot**, so it can briefly
> fight Argo until step 8 clears it.

> If, during step 8, a retained PV shows `Released` and won't rebind, clear its claimRef:
> `kubectl patch pv <pv> -p '{"spec":{"claimRef":null}}'` then recreate the PVC with
> `spec.volumeName: <pv>`.

### 5 · karakeep

Same recipe as memos (2 PVCs incl. the 50Gi `karakeep-data`; meili-data is rebuildable).
`argocd app diff karakeep` → sync → drop `./karakeep.nix` + rebuild → `argocd app sync routing`
→ verify remount + `https://karakeep.pvc.tools` → enable auto-sync.

### 6 · observability (the 4 Helm Applications)

Grafana PVC is backed up (step 0); prometheus/loki/tempo may reset — acceptable.

```bash
for a in observability-kps observability-loki observability-alloy observability-tempo; do argocd app diff $a; done
argocd app sync observability-kps     # ServerSideApply already set on the App
argocd app sync observability-loki observability-alloy observability-tempo
# drop observability.nix from Nix (removes the autoDeployCharts + grafana-route), rebuild:
#   git rm modules/k8s/observability.nix and drop it from default.nix imports
sudo nixos-rebuild switch --flake ~/sutures#pharika
argocd app sync routing   # re-assert the grafana route k3s just pruned
# verify Grafana remounts its PVC, dashboards intact, https://grafana.pvc.tools logs in via Authelia
```

Note: the grafana route is already Argo-owned since step 3 — the `argocd app sync routing`
above just recreates it immediately after the Nix prune.

### 7 · authelia — LAST

Everything's auth depends on it; forwardAuth keeps working while authelia is still Nix-owned,
so there's no rush. Keep each app's break-glass local login on.

```bash
argocd app diff authelia     # adopts deployment, redis, configmap, service, PVCs
argocd app sync authelia
# drop ./authelia.nix from Nix + rebuild (authelia-data + redis-data are Retain-protected)
sudo nixos-rebuild switch --flake ~/sutures#pharika
argocd app sync routing      # re-assert the auth.pvc.tools portal route k3s just pruned
# verify: login at https://auth.pvc.tools still works, a gated app still challenges + lets you in,
# sessions survive (redis), then enable auto-sync.
```

### 8 · cleanup

By now every workload + route is Argo-owned and the Nix app modules are gone. `traefik.nix`
keeps ONLY the controller HelmChartConfig + its porkbun secret ref (the dashboard IngressRoute
moved to the routing app).

```bash
# homer: debug cruft in default ns (NodePort 30441, not in Nix) — drop it:
kubectl -n default delete deploy/homer svc/homer
ssh pharika sudo rm -rf /srv/homer

# confirm Nix released everything and modules/k8s is just the substrate:
kubectl get addon -A    # no memos/karakeep/authelia/observability/*-route/grafana-ingress
#   modules/k8s/ now = k3s.nix + traefik.nix + argocd.nix + default.nix
```

> Leftover `grafana-ingress` Addon: if `kubectl get addon -A` still lists it, it's the dead
> host-less Ingress from before — delete the object once by hand after its module is gone.

## Verify (per app)

- `argocd app diff <app>` ≈ empty before sync (faithful adoption, no accidental reconfig).
- `curl -s -o /dev/null -w '%{http_code}' https://<app>.pvc.tools` after.
- LoadBalancer EXTERNAL-IPs still `10.0.0.141` (`kubectl get svc -A -o wide`).
- Stateful apps remount the **same** PV (not an empty one); app still appears in Grafana.
