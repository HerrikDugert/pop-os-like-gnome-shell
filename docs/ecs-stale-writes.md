# ECS stale-write protection (review fixes, part 2)

Base: ecs.ts at e994fc0 (unchanged from the reviewed snapshot). Can be applied after
idle-tiler-lifecycle-v2.patch; this package does not change that package's files.

Storage.insert and Storage.get_or throw StaleEntityError for invalid or obsolete
write identifiers. Stale get_or calls are rejected before running the initializer.
The public return type remains T; a stale request is not represented by a fake T
or a silent null result.

World.register_storage supplies a live-entity predicate. This rejects writes after
entity deletion, after slot reuse even before any new component exists, to future
invented generations, and to unallocated slots. Tuple identity remains value-based
(slot, generation); the Entity type does not carry a globally unique World ID.

Standalone new Storage() instances retain a successful-write high-water mark per
slot. remove() clears the component but not the mark. Standalone storage has no
World lifetime information, so same-generation reinsertion remains legal and an
entity deletion unseen by that storage cannot be inferred. Production sources in
the reviewed repository create their ECS storages through World.register_storage.

get_or copies the requested tuple before calling an initializer and revalidates
after it returns. If the initializer creates the actual component reentrantly,
that component is returned without overwriting it. An initializer failure does not
advance the fence. Entity tuples must still not be mutated after issuance; the
snapshot only prevents an initializer from redirecting this particular write.

Read/remove APIs retain their previous generation checks. In particular an
unregistered storage may retain snapshot reads, as the existing ECS test specifies,
while subsequent writes still require an alive owner entity.

27 new regressions and 9 existing ECS cases pass in a mechanically type-stripped
Node model here. The old implementation with only the error export added fails the
new suite. No TypeScript compiler or native GJS/Shell run was available here.

Expected local test totals including previously verified groups:
123 bare-Node ECS/idle/GTK/Shell/startup/lifecycle tests; 9 executor; 79 Config;
31 backend; 29 IPC; 27 Xprop = 298. Native GTK/GNOME integration, other direct timers,
lock recovery, regex limits and performance measurements remain separate work.
