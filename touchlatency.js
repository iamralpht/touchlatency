// Utility for computing touchscreen latency
// Copyright 2013 (C) Ralph Thomas, ralpht@gmail.com

(function() {
//
// The idea is that we have some external tool which moves a stylus
// in a circle on the screen. This program then "calibrates" (it tries
// to find the center and radius of the circle, and the time it takes
// to complete a revolution). Then it can show the circle on screen with
// the nearest point to the touchpoint drawn with a red indicator on the
// circle. The user can then adjust the touchpoint forwards so that it
// is visually centered underneath the stylus. Knowing how long it takes
// to complete a revolution tells us how many degrees/second the stylus
// is moving, so we can tell how far in the future we had to jump to
// eliminate lag -- this number is the latency figure we're after.
//
const STATE_UNCALIBRATED = 'uncalibrated'; // draw just the touch point
const STATE_CALIBRATING = 'calibrating'; // uncalibrated + add points to array
const STATE_CALIBRATED = 'calibrated'; // draw circle, touch point and closest

const TOUCH_HALFSIZE = 10;

var state = STATE_UNCALIBRATED;
var trackingId = -1;
var calibrationPoints = [];
var circle = null;
var nudgeTime = 0;
var transformStyleName = 'transform';

var domState = null;
var domErrors = null;
var domTouchPoint = null;
var domCircle = null;
var domProjectedPoint = null;

domTouchPoint = document.createElement('div');
domTouchPoint.className = 'touchpoint';
document.body.appendChild(domTouchPoint);

// Ensure we're using the correct style property for transform. Most WK
// and Moz use unprefixed transform, apparently Chrome is still prefixed.
if (domTouchPoint.style[transformStyleName] == undefined)
    transformStyleName = '-webkit-transform';

domProjectedPoint = document.createElement('div');
domProjectedPoint.className = 'touchpoint projected';
document.body.appendChild(domProjectedPoint);

domState = document.createElement('span');
domState.className = 'state';
domState.innerText = state;
document.body.appendChild(domState);

domErrors = document.createElement('span');
domErrors.className = 'errors';
document.body.appendChild(domErrors);

document.body.addEventListener('touchstart',
    function(e) {
        trackingId = e.changedTouches[0].identifier;
        e.preventDefault();
    }, false);
document.body.addEventListener('touchmove',
    function(e) {
        e.preventDefault();

        var touchPoint = null;
        for (var i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier == trackingId) {
                touchPoint = e.changedTouches[i];
                break;
            }
        }
        if (!touchPoint) return;

        domTouchPoint.style[transformStyleName] = 'translate3D(' + (touchPoint.pageX-TOUCH_HALFSIZE) + 'px, '+ (touchPoint.pageY-TOUCH_HALFSIZE) + 'px, 0)';

        switch (state) {
        case STATE_UNCALIBRATED:
            return;
        case STATE_CALIBRATING:
            calibrationPoints.push([e.timeStamp, touchPoint.pageX, touchPoint.pageY]);
            break;
        case STATE_CALIBRATED:
            updateProjection(e.timeStamp, touchPoint.pageX, touchPoint.pageY);
            break;
        }
    }, false);

// Add the control buttons: start calibrating, end calibrating, nudge forward, nudge backward.
{
    function addButton(cls, action) {
        var btn = document.createElement('div');
        btn.className = 'button ' + cls;
        btn.addEventListener('touchstart',
            function(e) {
                e.stopPropagation();
                e.preventDefault();
                action();
            }, true);
        document.body.appendChild(btn);
    }

    addButton('start-calibrating',
        function() {
            state = STATE_CALIBRATING;
            calibrationPoints = [];
            domState.innerText = state;
        });

    addButton('stop-calibrating', calibrate);
    addButton('inc-nudge', moveNudge.bind(null, 5));
    addButton('dec-nudge', moveNudge.bind(null, -5));
}

// Actual work
function calibrate() {
    // We want to walk all of the points in "calibrationPoints" and find the center. Because the machine is
    // supposed to be drawing a circle we can just average them. This means calibration should consist of
    // at least one complete circle.
    var px = 0;
    var py = 0;
    for (var i = 0; i < calibrationPoints.length; i++) {
        px += calibrationPoints[i][1];
        py += calibrationPoints[i][2];
    }
    px /= calibrationPoints.length;
    py /= calibrationPoints.length;
    // Find the radius by taking the average distance from the centerpoint. Probably don't need to average
    // here.
    var r = 0;
    for (var i = 0; i < calibrationPoints.length; i++) {
        var dx = px - calibrationPoints[i][1];
        var dy = py - calibrationPoints[i][2];
        r += Math.sqrt(dx * dx + dy * dy);
        // Push the angle so we can use it to compute velocity (in radians/sec).
        calibrationPoints[i].push(Math.atan2(calibrationPoints[i][1] - px, calibrationPoints[i][2] - py));
    }
    r /= calibrationPoints.length;
    circle = { r: r, cx: px, cy: py };
    //
    // Find the times we were at various angles and then use that to compute the time for a single
    // rotation.
    //
    function findTimeBetweenAngles(angle) {
        function normAngle(angle) { return (angle + Math.PI * 2.0) % (Math.PI * 2.0); }
        angle = normAngle(angle);
        var rotAngle = normAngle(angle + Math.PI);

        var wraps = 0;
        var times = [];
        var lastAngle = normAngle(calibrationPoints[0][3]);
        for (var i = 0; i < calibrationPoints.length; i++) {
            var thisAngle = normAngle(calibrationPoints[i][3]);
            var lowAngle = thisAngle > lastAngle ? lastAngle : thisAngle;
            var highAngle = thisAngle > lastAngle ? thisAngle : lastAngle;
            // move it along by PI to avoid matching where we wrap around 0. This isn't a very good solution.
            var rotLowAngle = normAngle(thisAngle + Math.PI);
            var rotHighAngle = normAngle(lastAngle + Math.PI);
            if (rotLowAngle > rotHighAngle) {
                var t = rotLowAngle; rotLowAngle = rotHighAngle; rotHighAngle = t;
            }

            if (thisAngle == angle) times.push(calibrationPoints[i][0]);
            else if (angle > lowAngle && angle < highAngle && rotAngle > rotLowAngle && rotAngle < rotHighAngle) {
                // lerp
                var baseTime = calibrationPoints[i-1][0];
                var deltaTime = calibrationPoints[i][0] - baseTime;
                var deltaAngle = thisAngle - lastAngle;
                var quantumTime = deltaTime / deltaAngle;
                times.push(baseTime + quantumTime * (angle - lastAngle));
            }
            lastAngle = thisAngle;
        }
        // Average
        if (times.length < 2) {
            console.log('not enough rotations to calibrate velocity');
            return -1;
        }
        var deltas = [];
        var sum = 0;
        for (var i = 1; i < times.length; i++) { deltas.push(times[i] - times[i-1]); sum += times[i] - times[i-1]; }
        sum /= times.length -1;
        return sum;
    }
    var qTime = findTimeBetweenAngles(Math.PI / 2);
    var tqTime = findTimeBetweenAngles(Math.PI * 1.5);
    if (Math.abs(qTime - tqTime) > 30) {
        domErrors.textContent = 'Inconsistent revolution times: ' + qTime + 'ms ' + tqTime + 'ms';
    }
    circle.time = (qTime + tqTime) / 2.0;
    //
    // Now make a circle DOM element.
    //
    if (domCircle) document.body.removeChild(domCircle);
    domCircle = document.createElement('div');
    domCircle.className = 'circle';
    domCircle.style.width = 2 * r + 'px';
    domCircle.style.height = 2 * r + 'px';
    domCircle.style.borderRadius = (r*2) + 'px';
    domCircle.style.left = (px - r) + 'px';
    domCircle.style.top = (py - r) + 'px';
    document.body.appendChild(domCircle);

    state = STATE_CALIBRATED;
    domState.textContent = STATE_CALIBRATED;
}
function updateProjection(timeStamp, x, y) {
    if (!circle) return;
    var vx = x - circle.cx;
    var vy = y - circle.cy;
    var mag = Math.sqrt(vx * vx + vy * vy);
    var ax = circle.cx + vx / mag * circle.r;
    var ay = circle.cy + vy / mag * circle.r;
    // [ax, ay] is the nearest point to the touchpoint which is on the circle.

    var angle = Math.atan2(ax - circle.cx, ay - circle.cy);
    // Now apply the nudge. The nudge is measured in milliseconds.
    var velocity = (Math.PI * 2.0) / circle.time;
    var nudgeAngleDelta = velocity * nudgeTime;
    angle += nudgeAngleDelta;

    ax = circle.cx + circle.r * Math.sin(angle);
    ay = circle.cy + circle.r * Math.cos(angle);

    domProjectedPoint.style[transformStyleName] = 'translate3D(' + (ax - TOUCH_HALFSIZE) + 'px, ' + (ay - TOUCH_HALFSIZE) + 'px, 0)';
}
function moveNudge(amount) {
    nudgeTime += amount;
    domErrors.textContent = 'NUDGE ' + nudgeTime + 'ms';
}
})();
