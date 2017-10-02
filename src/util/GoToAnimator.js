/*
 * Copyright (C) 2014 United States Government as represented by the Administrator of the
 * National Aeronautics and Space Administration. All Rights Reserved.
 */
// The issue here is probably that I try to get into a center the camera instead of the point the LookAt would point to.
/**
 * @exports GoToAnimator
 * @version $Id: GoToAnimator.js 3164 2015-06-09 15:35:14Z tgaskins $
 */
define([
        '../navigate/Camera',
        '../geom/Location',
        '../util/Logger',
        '../navigate/LookAt',
        '../geom/Position',
        '../geom/Vec3'
    ],
    function (Camera,
              Location,
              Logger,
              LookAt,
              Position,
              Vec3) {
        "use strict";

        /**
         * Constructs a GoTo animator.
         * @alias GoToAnimator
         * @constructor
         * @classdesc Incrementally and smoothly moves a {@link Navigator} to a specified position.
         * @param {WorldWindow} worldWindow The World Window in which to perform the animation.
         * @throws {ArgumentError} If the specified World Window is null or undefined.
         */
        var GoToAnimator = function (worldWindow) {
            if (!worldWindow) {
                throw new ArgumentError(Logger.logMessage(Logger.LEVEL_SEVERE, "GoToAnimator", "constructor",
                    "missingWorldWindow"));
            }

            /**
             * The World Window associated with this animator.
             * @type {WorldWindow}
             * @readonly
             */
            this.wwd = worldWindow;

            /**
             * The frequency in milliseconds at which to animate the position change.
             * @type {Number}
             * @default 20
             */
            this.animationFrequency = 20;

            /**
             * The animation's duration, in milliseconds. When the distance is short, less than twice the viewport
             * size, the travel time is reduced proportionally to the distance to travel. It therefore takes less
             * time to move shorter distances.
             * @type {Number}
             * @default 3000
             */
            this.travelTime = 3000;

            /**
             * Indicates whether the current or most recent animation has been cancelled. Use the cancel() function
             * to cancel an animation.
             * @type {Boolean}
             * @default false
             * @readonly
             */
            this.cancelled = false;
        };

        // Stop the current animation.
        GoToAnimator.prototype.cancel = function () {
            this.cancelled = true;
        };

        /**
         * Moves the navigator to a specified location or position.
         * @param {Location | Position} position The location or position to move the navigator to. If this
         * argument contains an "altitude" property, as {@link Position} does, the end point of the navigation is
         * at the specified altitude. Otherwise the end point is at the current altitude of the navigator.
         * @param {Function} completionCallback If not null or undefined, specifies a function to call when the
         * animation completes. The completion callback is called with a single argument, this animator.
         * @throws {ArgumentError} If the specified location or position is null or undefined.
         */
        GoToAnimator.prototype.goTo = function (position, completionCallback) {
            if (!position) {
                throw new ArgumentError(Logger.logMessage(Logger.LEVEL_SEVERE, "GoToAnimator", "goTo",
                    "missingPosition"));
            }

            var camera = new Camera();
            this.wwd.navigator.getAsCamera(this.wwd.globe, camera);

            this.completionCallback = completionCallback;

            // Reset the cancellation flag.
            this.cancelled = false;

            // Capture the target position and determine its altitude.
            this.targetPosition = this.getTargetPosition(position);

            // Capture the start position and start time.
            this.startPosition = new Position(
                camera.latitude,
                camera.longitude,
                camera.altitude);
            this.startTime = Date.now();

            // Determination of the pan and range velocities requires the distance to be travelled.
            var animationDuration = this.travelTime,
                panDistance = Location.greatCircleDistance(this.startPosition, this.targetPosition),
                rangeDistance;

            // Determine how high we need to go to give the user context. The max altitude computed is approximately
            // that needed to fit the start and end positions in the same viewport assuming a 45 degree field of view.
            var pA = this.wwd.globe.computePointFromLocation(
                    this.startPosition.latitude, this.startPosition.longitude, new Vec3(0, 0, 0)),
                pB = this.wwd.globe.computePointFromLocation(
                    this.targetPosition.latitude, this.targetPosition.longitude, new Vec3(0, 0, 0));
            this.maxAltitude = pA.distanceTo(pB);

            // Determine an approximate viewport size in radians in order to determine whether we actually change
            // the range as we pan to the new location. We don't want to change the range if the distance between
            // the start and target positions is small relative to the current viewport.
            var viewportSize = this.wwd.navigator.currentState().pixelSizeAtDistance(this.startPosition.altitude)
                * this.wwd.canvas.clientWidth / this.wwd.globe.equatorialRadius;

            if (panDistance <= 2 * viewportSize) {
                // Start and target positions are close, so don't back out.
                this.maxAltitude = this.startPosition.altitude;
            }

            // We need to capture the time the max altitude is reached in order to begin decreasing the range
            // midway through the animation. If we're already above the max altitude, then that time is now since
            // we don't back out if the current altitude is above the computed max altitude.
            this.maxAltitudeReachedTime = this.maxAltitude <= camera.altitude ? Date.now() : null;

            // Compute the total range to travel since we need that to compute the range velocity.
            // Note that the range velocity and pan velocity are computed so that the respective animations, which
            // operate independently, finish at the same time.
            if (this.maxAltitude > this.startPosition.altitude) {
                rangeDistance = Math.max(0, this.maxAltitude - this.startPosition.altitude);
                rangeDistance += Math.abs(this.targetPosition.altitude - this.maxAltitude);
            } else {
                rangeDistance = Math.abs(this.targetPosition.altitude - this.startPosition.altitude);
            }

            // Determine which distance governs the animation duration.
            var animationDistance = Math.max(panDistance, rangeDistance / this.wwd.globe.equatorialRadius);
            if (animationDistance === 0) {
                return; // current and target positions are the same
            }

            if (animationDistance < 2 * viewportSize) {
                // Start and target positions are close, so reduce the travel time based on the
                // distance to travel relative to the viewport size.
                animationDuration = Math.min((animationDistance / viewportSize) * this.travelTime, this.travelTime);
            }

            // Don't let the animation duration go to 0.
            animationDuration = Math.max(1, animationDuration);

            // Determine the pan velocity, in radians per millisecond.
            this.panVelocity = panDistance / animationDuration;

            // Determine the range velocity, in meters per millisecond.
            this.rangeVelocity = rangeDistance / animationDuration; // meters per millisecond

            // Set up the animation timer.
            var thisAnimator = this;
            var timerCallback = function () {
                if (thisAnimator.cancelled) {
                    if (thisAnimator.completionCallback) {
                        thisAnimator.completionCallback(thisAnimator);
                    }
                    return;
                }

                if (thisAnimator.update()) {
                    setTimeout(timerCallback, thisAnimator.animationFrequency);
                } else if (thisAnimator.completionCallback) {
                    thisAnimator.completionCallback(thisAnimator);
                }
            };
            setTimeout(timerCallback, this.animationFrequency); // invoke it the first time
        };

        /**
         * This function gets the information which is in the LookAt format and transforms it to the Camera position
         * usable to verify we are at the target point.
         * @param position {Position|Location} Final position required by the user.
         */
        GoToAnimator.prototype.getTargetPosition = function(position) {
            var lookAt = new LookAt();
            this.wwd.navigator.getAsLookAt(this.wwd.globe, lookAt);
            if(position.altitude !==  null && typeof position.altitude !== "undefined") {
                lookAt.altitude = position.altitude;
            }
            lookAt.latitude = position.latitude;
            lookAt.longitude = position.longitude;
            var resultCamera = new Camera();
            this.wwd.globe.lookAtToCamera(lookAt, resultCamera);

            return new Position(resultCamera.latitude, resultCamera.longitude, resultCamera.altitude);
        };

        // Intentionally not documented.
        GoToAnimator.prototype.update = function () {
            // This is the timer callback function. It invokes the range animator and the pan animator.

            // TODO: Refactor.
            var camera = new Camera();
            this.wwd.navigator.getAsCamera(this.wwd.globe, camera);

            var currentPosition = new Position(
                camera.latitude,
                camera.longitude,
                camera.altitude);

            var continueAnimation = this.updateRange(currentPosition);
            continueAnimation = this.updateLocation(currentPosition) || continueAnimation;

            this.wwd.redraw();

            return continueAnimation;
        };

        // Intentionally not documented.
        GoToAnimator.prototype.updateRange = function (currentPosition) {
            // This function animates the range.
            var continueAnimation = false,
                nextRange, elapsedTime;

            var camera = new Camera();
            this.wwd.navigator.getAsCamera(this.wwd.globe, camera);

            // If we haven't reached the maximum altitude, then step-wise increase it. Otherwise step-wise change
            // the range towards the target altitude.
            if (!this.maxAltitudeReachedTime) {
                elapsedTime = Date.now() - this.startTime;
                nextRange = Math.min(this.startPosition.altitude + this.rangeVelocity * elapsedTime, this.maxAltitude);
                // We're done if we get withing 1 meter of the desired range.
                if (Math.abs(camera.altitude - nextRange) < 1) {
                    this.maxAltitudeReachedTime = Date.now();
                }
                camera.altitude = nextRange;
                this.wwd.navigator.setAsCamera(this.wwd.globe, camera);
                continueAnimation = true;
            } else {
                elapsedTime = Date.now() - this.maxAltitudeReachedTime;
                if (this.maxAltitude > this.targetPosition.altitude) {
                    nextRange = this.maxAltitude - (this.rangeVelocity * elapsedTime);
                    nextRange = Math.max(nextRange, this.targetPosition.altitude);
                } else {
                    nextRange = this.maxAltitude + (this.rangeVelocity * elapsedTime);
                    nextRange = Math.min(nextRange, this.targetPosition.altitude);
                }
                camera.altitude = nextRange;
                this.wwd.navigator.setAsCamera(this.wwd.globe, camera);
                // We're done if we get withing 1 meter of the desired range.
                continueAnimation = Math.abs(camera.altitude - this.targetPosition.altitude) > 1;
            }

            return continueAnimation;
        };

        // Intentionally not documented.
        GoToAnimator.prototype.updateLocation = function (currentPosition) {
            var camera = new Camera();
            this.wwd.navigator.getAsCamera(this.wwd.globe, camera);

            // This function animates the pan to the desired location.
            var elapsedTime = Date.now() - this.startTime,
                distanceTravelled = Location.greatCircleDistance(this.startPosition, currentPosition),
                distanceRemaining = Location.greatCircleDistance(currentPosition, this.targetPosition),
                azimuthToTarget = Location.greatCircleAzimuth(currentPosition, this.targetPosition),
                distanceForNow = this.panVelocity * elapsedTime,
                nextDistance = Math.min(distanceForNow - distanceTravelled, distanceRemaining),
                nextLocation = Location.greatCircleLocation(currentPosition, azimuthToTarget, nextDistance,
                    new Location(0, 0)),
                locationReached = false;

            camera.latitude = nextLocation.latitude;
            camera.longitude = nextLocation.longitude;

            this.wwd.navigator.setAsCamera(this.wwd.globe, camera);

            // We're done if we're within a meter of the desired location.
            if (nextDistance < 1 / this.wwd.globe.equatorialRadius) {
                locationReached = true;
            }

            if(elapsedTime > 4000) {
                locationReached = true;
            }

            return !locationReached;
        };

        return GoToAnimator;
    });