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

Workloads are grouped `<purpose>/<tool>/<component>.yaml` (makko-style). Argo Application CRs
stay central in `apps/`, each pointing at its tool dir:

```
bootstrap/root.yaml   root app-of-apps -> apps/  (mirrors sutures' argocd.nix; that addon applies it)
apps/                 one Argo Application per workload (sync-wave ordered)
auth/
  authelia/           namespace, pvcs, configmap, deployment, service, redis
monitoring/
  kube-prometheus-stack/values.yaml    # the one Helm app (chart is huge: operator + CRDs + rules)
  loki/  alloy/  tempo/                 # plain YAML, rendered from their charts (no Helm needed)
default/
  memos/  karakeep/   the user-facing apps
  routing/            all IngressRoutes + per-ns Authelia forwardAuth Middlewares
```

Why these names: `default/` is the catch-all (incl. routing — parked here on purpose, since
Cilium + Gateway API will soon rewrite these Traefik routes into `HTTPRoute`s under a future
`gateway/`; no point minting a `networking/` category for something about to be replaced).
`argocd/` is reserved for Argo's own extras (a future `argocd.pvc.tools` route, AppProjects) —
the install itself is Nix, so it's empty until then.

Only **kube-prometheus-stack** uses Helm (via Argo multi-source: chart upstream + `values.yaml`
here through `$values`). loki/alloy/tempo were rendered once with `helm template` and committed
as plain manifests — re-render on a version bump rather than hand-editing.

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

### 2 · Confirm the loop

The git -> Argo -> cluster loop is already proven: the root app-of-apps pulled `apps/` from
GitHub and created every child Application. Just confirm the roster:

```bash
kubectl -n argocd get applications      # root Synced; children OutOfSync (manual) / Healthy
```

(There's no `whoami` smoke-test app — root fanning out is the same proof, so it was dropped.)

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
argocd app diff memos        # EXPECT ~nothing: Argo is adopting the live objects
argocd app sync memos        # adopt (manual); still Nix-owned too, harmless
# hand ownership to Argo: remove memos from Nix, rebuild (Retain protects the data)
#   edit ~/sutures/modules/k8s/default.nix -> drop ./memos.nix ; git rm modules/k8s/memos.nix
sudo nixos-rebuild switch --flake ~/sutures#pharika
argocd app sync routing                      # re-assert the memos route k3s just pruned
kubectl -n memos get pods -w                 # pod remounts the SAME memos-data PV
kubectl get addon -A | grep memos || echo "nix released memos ✓"
curl -s -o /dev/null -w '%{http_code}\n' https://memos.pvc.tools
# verified? turn on continuous reconcile:
#   uncomment the automated: block in apps/memos.yaml, commit+push, then:
argocd app sync memos
```

> If a retained PV later shows `Released` and won't rebind, clear its claimRef:
> `kubectl patch pv <pv> -p '{"spec":{"claimRef":null}}'` then recreate the PVC with
> `spec.volumeName: <pv>`.

### 5 · karakeep

Same recipe as memos (2 PVCs incl. the 50Gi `karakeep-data`; meili-data is rebuildable).
`argocd app diff karakeep` → sync → drop `./karakeep.nix` + rebuild → `argocd app sync routing`
→ verify remount + `https://karakeep.pvc.tools` → enable auto-sync.

### 6 · observability (kps Helm + loki/alloy/tempo plain)

Unlike the stateful apps, this one is **drop-Nix-first, then Argo-sync** (a reset-and-recreate,
not an adopt). Reason: the live LGTM stack is 4 Nix *Helm releases*; our Argo versions render
to the same object names, so syncing while the Nix releases still exist means fighting over
ownership. Cleaner to let k3s `helm uninstall` them, then let Argo install fresh. Grafana PVC is
backed up + Retain'd (step 0); prometheus/loki/tempo data resets — acceptable (short retention).
Expect a brief monitoring gap; it's non-critical.

```bash
# 1) remove observability.nix from Nix + rebuild -> k3s helm-uninstalls all 4 releases.
#    (CRDs survive uninstall; Prometheus/Alertmanager/loki/tempo PVCs are deleted — grafana's PV
#     is Retain'd so its data survives even as the PVC goes.)
#    git rm modules/k8s/observability.nix and drop ./observability.nix from default.nix imports
sudo nixos-rebuild switch --flake ~/sutures#pharika

# 2) install the stack under Argo (kps is Helm+ServerSideApply; the other 3 are plain YAML):
argocd app sync observability-kps --core
argocd app sync observability-loki observability-alloy observability-tempo --core

# 3) restore Grafana data: rebind its retained PV to the fresh kube-prometheus-stack-grafana PVC
#    (clear the old claimRef + set spec.volumeName), or restore /tmp/grafana.tgz into the new PV.
#    Then re-assert the grafana route k3s pruned with the module:
argocd app sync routing --core
# verify: dashboards intact, https://grafana.pvc.tools logs in via Authelia, tempo now present.
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
