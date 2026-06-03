'use strict';

// ── EmitterScheduler ──────────────────────────────────────────────────────────
// Owns one smoke emitter's position, velocity, intensity, and time schedule.
//
// Time-varying behaviour is driven by an optional trajectory callback:
//
//   trajectory(elapsed)  →  { x, y, z, vx, vy, vz, density, temperature }
//
// where `elapsed` is seconds since the last reset().
// Any field in the returned object overrides the emitter's current value for
// that frame.  Omitted fields keep their previous value.
//
// Usage pattern each frame:
//   scheduler.update(dt);   // advance clock, apply trajectory, fire burst if needed
//   scheduler.emit();       // inject smoke if currently active

class EmitterScheduler {
    constructor (cfg) {
        // ── Static / initial values ───────────────────────────────────────────
        this.x           = cfg.x           !== undefined ? cfg.x           : 0.5;
        this.y           = cfg.y           !== undefined ? cfg.y           : 0.5;
        this.z           = cfg.z           !== undefined ? cfg.z           : 0.5;

        // 3-axis velocity (cfg.vy also accepts legacy cfg.velocityY)
        this.vx          = cfg.vx          !== undefined ? cfg.vx          : 0.0;
        this.vy          = cfg.vy          !== undefined ? cfg.vy
                         : cfg.velocityY   !== undefined ? cfg.velocityY
                         : config.EMIT_VELOCITY_Y;
        this.vz          = cfg.vz          !== undefined ? cfg.vz          : 0.0;

        this.density     = cfg.density     !== undefined ? cfg.density     : config.EMIT_DENSITY;
        this.temperature = cfg.temperature !== undefined ? cfg.temperature : config.EMIT_TEMPERATURE;

        // ── Schedule ──────────────────────────────────────────────────────────
        this.startTime = cfg.startTime !== undefined ? cfg.startTime : 0;
        this.endTime   = cfg.endTime   !== undefined ? cfg.endTime   : Infinity;

        // ── Trajectory callback (optional) ────────────────────────────────────
        // (elapsed) => { x?, y?, z?, vx?, vy?, vz?, density?, temperature? }
        this._trajectory = cfg.trajectory || null;

        this._elapsed = 0;
        this._bursted = false;
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    get active ()  { return this._elapsed >= this.startTime && this._elapsed < this.endTime; }
    get elapsed () { return this._elapsed; }

    // ── Control ───────────────────────────────────────────────────────────────

    reset () {
        this._elapsed = 0;
        this._bursted = false;
    }

    // ── Per-frame ─────────────────────────────────────────────────────────────

    // Advance the clock by dt seconds, apply trajectory, fire burst on first
    // active frame.
    update (dt) {
        this._elapsed += dt;
        this._applyTrajectory();

        if (this.active && !this._bursted) {
            this._bursted = true;
            this._burst();
        }
    }

    // Inject one frame of continuous emission into the simulation volumes.
    emit () {
        if (!this.active) return;

        splat3D(this.x, this.y, this.z,
                this.density, this.density, this.density,
                config.EMIT_RADIUS, density);

        splat3D(this.x, this.y, this.z,
                this.temperature, 0.0, 0.0,
                config.EMIT_RADIUS, temperature);

        splat3D(this.x, this.y, this.z,
                this.vx, this.vy, this.vz,
                config.EMIT_RADIUS, velocity3D);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _applyTrajectory () {
        if (!this._trajectory) return;
        const s = this._trajectory(this._elapsed);
        if (!s) return;
        if (s.x           !== undefined) this.x           = s.x;
        if (s.y           !== undefined) this.y           = s.y;
        if (s.z           !== undefined) this.z           = s.z;
        if (s.vx          !== undefined) this.vx          = s.vx;
        if (s.vy          !== undefined) this.vy          = s.vy;
        if (s.vz          !== undefined) this.vz          = s.vz;
        if (s.density     !== undefined) this.density     = s.density;
        if (s.temperature !== undefined) this.temperature = s.temperature;
    }

    _burst () {
        splat3D(this.x, this.y, this.z,
                this.density, this.density, this.density,
                config.EMIT_RADIUS * 4.0, density);

        splat3D(this.x, this.y, this.z,
                this.temperature * 2.0, 0.0, 0.0,
                config.EMIT_RADIUS * 4.0, temperature);

        splat3D(this.x, this.y, this.z,
                this.vx, this.vy, this.vz,
                config.EMIT_RADIUS * 4.0, velocity3D);
    }
}
