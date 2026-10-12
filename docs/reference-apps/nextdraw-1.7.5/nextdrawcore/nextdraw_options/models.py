# Copyright 2025 Windell H. Oskay, Bantam Tools

"""
models.py

Definitions of specific plotter models and handling modes.
Part of the NextDraw driver software
http://bantamtools.com

The classes defined by this function are:
* ZMotor: An object giving properties of a pen-lift motor type

* Handler: An object giving properties of the different handling modes

* Plotter: An object giving properties of a plotter model


"""

class ZMotor:
    """
    Class for definition of pen-lift servo motors types, for setting
        parameters that are specific to the plotter model.
    Servo motion limits, "max" and "min" are PWM widths, 
        given in units of (1/12 MHz), about 83.3 ns.
    """
    # pylint: disable=too-few-public-methods

    def __init__(self):
        self.motor_name = ""        # Human-readable name of motor
        self.pin = 0                # I/O pin that motor is driven by.
        self.max = 0                # Maximum position; up 100%.
        self.min = 0                # Maximum position; down 0%.
        self.sweep_time = 0         # Duration, ms, to sweep control signal over 100% range
        self.move_min = 0           # Minimum time, ms, for pen lift/lower of non-zero distance
        self.move_slope = 0         # Additional time, ms, per % of vertical travel


class Handler:
    """
    Class for definition of handling modes, which define how machine is used.

    Handlers allow definition of operation parameter sets that can give higher
    performance than general-purpose settings. For example, a handler that limits
    the maximum travel speed but increases acceleration (beyond that which would
    be allowed at the overall maximum travel speed) will give faster overall
    performance on plots that never would reach that maximum travel speed.
    """
    # pylint: disable=too-few-public-methods

    def __init__(self):
        self.name = ""              # Human-readable name of handling mode
        self.resolution = 0         # Resolution 1: High (2874 steps/in), 2: Low (1437 steps/in)
        self.jerk = 0               # Nominal pen-down jerk value. 0 -> Constant speed.
        self.speed = 0              # Speed limit, inch/s
        self.speed_up = 0           # Speed limit, pen-up, inch/s
        self.tolerance = 0          # Allowed error, inch, on curve sampling
        self.homing = 0             # Reserved for future use: Quick homing mode


class Plotter:
    """
    Class for definition of plotter models for use in the Bantam Tools NextDraw software,
    setting parameters that are specific to the model.
    """
    # pylint: disable=too-few-public-methods

    def __init__(self):
        self.handler_name = ""      # Human-readable model name
        self.travel_x = 0           # x-travel, inches
        self.travel_y = 0           # y-travel, inches
        self.jerk_pen_up_hi = 0     # maximum pen-up jerk value, high res in/s^3
        self.jerk_pen_up_lo = 0     # maximum pen-up jerk value, low res in/s^3
        self.jerk_derate = 1        # Derating factor for pen-down jerk per model.
        self.auto_home = False      # Boolean. True if model supports automatic homing
        self.z_motor = 1            # 0 for standard servo, 1 for brushless pen-lift

z_motors = [ZMotor() for i in range(2)]

z_motors[0].motor_name = "Standard servo"
z_motors[0].pin = 1                 # I/O pin that motor is driven by.
z_motors[0].max = 27831             # Maximum position; up 100%.
z_motors[0].min = 9855              # Maximum position; down 0%.
z_motors[0].sweep_time = 200        # Duration, ms, to sweep control signal over 100% range
z_motors[0].move_min = 45           # Minimum time, ms, for pen lift/lower of non-zero distance
z_motors[0].move_slope = 2.69       # Additional time, ms, per % of vertical travel

z_motors[1].motor_name = "Narrow-band brushless servo"
z_motors[1].pin = 2                  # I/O pin that motor is driven by.
z_motors[1].max = 12600             # Maximum position; up 100%.
z_motors[1].min = 5400              # Maximum position; down 0%.
z_motors[1].sweep_time = 70         # Duration, ms, to sweep control signal over 100% range
z_motors[1].move_min = 20           # Minimum time, ms, for pen lift/lower of non-zero distance
z_motors[1].move_slope = 1.28       # Additional time, ms, per % of vertical travel


handlers = [Handler() for i in range(5)]

handlers[0].name = "No handler selected"

handlers[1].name = "Technical drawing"   # Human-readable name of handling mode
handlers[1].resolution = 1          # Resolution 1: High (2874 steps/in), 2: Low (1437 steps/in)
handlers[1].jerk = 20000            # Nominal pen-down jerk value (or 0 for constant speed)
handlers[1].speed = 8.6979          # Speed limit, inch/s
handlers[1].speed_up = 8.6979       # Speed limit, pen-up inch/s
handlers[1].tolerance = .002        # Allowed error, inch, on curve sampling
handlers[1].homing = 0              # Reserved for future use: Quick homing mode

handlers[2].name = "Handwriting"    # Human-readable name of handling mode
handlers[2].resolution = 2          # Resolution 1: High (2874 steps/in), 2: Low (1437 steps/in)
handlers[2].jerk = 90000            # Nominal pen-down jerk value (or 0 for constant speed)
handlers[2].speed = 7               # Speed limit, inch/s
handlers[2].speed_up = 12           # Speed limit, pen-up inch/s
handlers[2].tolerance = .008        # Allowed error, inch, on curve sampling
handlers[2].homing = 0              # Reserved for future use: Quick homing mode

handlers[3].name = "Sketching"      # Human-readable name of handling mode
handlers[3].resolution = 2          # Resolution 1: High (2874 steps/in), 2: Low (1437 steps/in)
handlers[3].jerk = 14000             # Nominal pen-down jerk value (or 0 for constant speed)
handlers[3].speed = 12              # Speed limit, inch/s
handlers[3].speed_up = 12           # Speed limit, pen-up inch/s
handlers[3].tolerance = .005        # Allowed error, inch, on curve sampling
handlers[3].homing = 0              # Reserved for future use: Quick homing mode

handlers[4].name = "Constant speed" # Human-readable name of handling mode
handlers[4].resolution = 1          # Resolution 1: High (2874 steps/in), 2: Low (1437 steps/in)
handlers[4].jerk = 0                # Nominal pen-down jerk value (or 0 for constant speed)
handlers[4].speed = 3.0            # Speed limit, inch/s
handlers[4].speed_up = 8.6979       # Speed limit, pen-up inch/s
handlers[4].tolerance = .002        # Allowed error, inch, on curve sampling
handlers[4].homing = 0              # Reserved for future use: Quick homing mode



plotters = [Plotter() for i in range(11)]

plotters[0].model_name = "No model selected"

plotters[1].model_name = "AxiDraw V3 or SE/A4"       # Human-readable model name
plotters[1].travel_x = 11.81              # x-travel, inches
plotters[1].travel_y = 8.58               # y-travel, inches
plotters[1].jerk_pen_up_hi = 19000        # maximum pen-up jerk value, high res, in/s^3
plotters[1].jerk_pen_up_lo = 13000        # maximum pen-up jerk value in/s^3
plotters[1].jerk_derate = 1.0             # Derating factor for pen-down jerk.
plotters[1].auto_home = False             # Boolean. True if model supports automatic homing
plotters[1].z_motor = 0                   # 0 for standard servo, 1 for brushless pen-lift

plotters[2].model_name = "AxiDraw V3/A3 or SE/A3"         # Human-readable model name
plotters[2].travel_x = 16.93              # x-travel, inches
plotters[2].travel_y = 11.69              # y-travel, inches
plotters[2].jerk_pen_up_hi = 17000        # maximum pen-up jerk value, high res, in/s^3
plotters[2].jerk_pen_up_lo = 12000        # maximum pen-up jerk value in/s^3
plotters[2].jerk_derate = 0.9             # Derating factor for pen-down jerk.
plotters[2].auto_home = False             # Boolean. True if model supports automatic homing
plotters[2].z_motor = 0                   # 0 for standard servo, 1 for brushless pen-lift

plotters[3].model_name = "AxiDraw V3 XLX"                 # Human-readable model name
plotters[3].travel_x = 23.42              # x-travel, inches
plotters[3].travel_y = 8.58               # y-travel, inches
plotters[3].jerk_pen_up_hi = 18000         # maximum pen-up jerk value, high res, in/s^3
plotters[3].jerk_pen_up_lo = 13000         # maximum pen-up jerk value in/s^3
plotters[3].jerk_derate = 1.0             # Derating factor for pen-down jerk.
plotters[3].auto_home = False             # Boolean. True if model supports automatic homing
plotters[3].z_motor = 0                   # 0 for standard servo, 1 for brushless pen-lift

plotters[4].model_name = "AxiDraw MiniKit"                # Human-readable model name
plotters[4].travel_x = 6.30               # x-travel, inches
plotters[4].travel_y = 4.00               # y-travel, inches
plotters[4].jerk_pen_up_hi = 6000         # maximum pen-up jerk value, high res, in/s^3
plotters[4].jerk_pen_up_lo = 6000         # maximum pen-up jerk value in/s^3
plotters[4].jerk_derate = 0.6             # Derating factor for pen-down jerk.
plotters[4].auto_home = False             # Boolean. True if model supports automatic homing
plotters[4].z_motor = 0                   # 0 for standard servo, 1 for brushless pen-lift

plotters[5].model_name = "AxiDraw SE/A1"                  # Human-readable model name
plotters[5].travel_x = 34.02              # x-travel, inches
plotters[5].travel_y = 23.39              # y-travel, inches
plotters[5].jerk_pen_up_hi = 13000        # maximum pen-up jerk value, high res, in/s^3
plotters[5].jerk_pen_up_lo = 8000         # maximum pen-up jerk value in/s^3
plotters[5].jerk_derate = 0.6             # Derating factor for pen-down jerk.
plotters[5].auto_home = False             # Boolean. True if model supports automatic homing
plotters[5].z_motor = 0                   # 0 for standard servo, 1 for brushless pen-lift

plotters[6].model_name = "AxiDraw SE/A2"                  # Human-readable model name
plotters[6].travel_x = 23.39              # x-travel, inches
plotters[6].travel_y = 17.01              # y-travel, inches
plotters[6].jerk_pen_up_hi = 16000        # maximum pen-up jerk value, high res, in/s^3
plotters[6].jerk_pen_up_lo = 10000        # maximum pen-up jerk value in/s^3
plotters[6].jerk_derate = 0.7             # Derating factor for pen-down jerk.
plotters[6].auto_home = False             # Boolean. True if model supports automatic homing
plotters[6].z_motor = 0                   # 0 for standard servo, 1 for brushless pen-lift

plotters[7].model_name = "AxiDraw V3/B6"                  # Human-readable model name
plotters[7].travel_x = 7.48               # x-travel, inches
plotters[7].travel_y = 5.51               # y-travel, inches
plotters[7].jerk_pen_up_hi = 14000        # maximum pen-up jerk value, high res, in/s^3
plotters[7].jerk_pen_up_lo = 14000        # maximum pen-up jerk value in/s^3
plotters[7].jerk_derate = 1.0             # Derating factor for pen-down jerk.
plotters[7].auto_home = False             # Boolean. True if model supports automatic homing
plotters[7].z_motor = 0                   # 0 for standard servo, 1 for brushless pen-lift

plotters[8].model_name = "Bantam Tools NextDraw™ 8511"    # Human-readable model name
plotters[8].travel_x = 11.81              # x-travel, inches
plotters[8].travel_y = 8.58               # y-travel, inches
plotters[8].jerk_pen_up_hi = 19000        # maximum pen-up jerk value, high res, in/s^3
plotters[8].jerk_pen_up_lo = 13000        # maximum pen-up jerk value in/s^3
plotters[8].jerk_derate = 1.0             # Derating factor for pen-down jerk.
plotters[8].auto_home = True              # Boolean. True if model supports automatic homing
plotters[8].z_motor = 1                   # 0 for standard servo, 1 for brushless pen-lift

plotters[9].model_name = "Bantam Tools NextDraw™ 1117"    # Human-readable model name
plotters[9].travel_x = 16.93              # x-travel, inches
plotters[9].travel_y = 11.69              # y-travel, inches
plotters[9].jerk_pen_up_hi = 17000        # maximum pen-up jerk value, high res, in/s^3
plotters[9].jerk_pen_up_lo = 12000        # maximum pen-up jerk value in/s^3
plotters[9].jerk_derate = 0.9             # Derating factor for pen-down jerk.
plotters[9].auto_home = True              # Boolean. True if model supports automatic homing
plotters[9].z_motor = 1                   # 0 for standard servo, 1 for brushless pen-lift

plotters[10].model_name = "Bantam Tools NextDraw™ 2234"   # Human-readable model name
plotters[10].travel_x = 34.02             # x-travel, inches
plotters[10].travel_y = 23.39             # y-travel, inches
plotters[10].jerk_pen_up_hi = 13000       # maximum pen-up jerk value, high res, in/s^3
plotters[10].jerk_pen_up_lo = 8000        # maximum pen-up jerk value in/s^3
plotters[10].jerk_derate = 0.6            # Derating factor for pen-down jerk.
plotters[10].auto_home = True             # Boolean. True if model supports automatic homing
plotters[10].z_motor = 1                  # 0 for standard servo, 1 for brushless pen-lift



def apply_model_and_handling(nd_ref, initialize=False):
    '''
    Apply machine-specific defaults such as travel and homing ability,
    Apply effects of chosen Handling mode
    Apply servo-specific defaults such as servo max & min positions, and
    Apply any pending overrides of these defaults.

    In detail:
    * Check if `options.model == params.model_old`. If not:
        * Set `params.model_old` = `options.model`
        * Apply model-specific values to params.
        * Using `options.penlift`, change the value of `params.z_motor` if indicated.
    * Apply any overrides to the model-specific values (even if model has not changed).
    * Check if `params.z_motor == params.z_motor_old `. If not:
        * Set `params.z_motor_old` = `params.z_motor` 
        * Using value of `params.z_motor`, select and apply servo-specific `params` values.
    * Apply any overrides to the servo-specific `params` values (even if servo has not changed)

    '''
    if initialize:
        nd_ref.params.model_old = -1
        nd_ref.params.handling_old = -1
        nd_ref.params.z_motor_old = -1

    model = nd_ref.options.model
    if model == 0: # Model has not been set.
        return

    if model != nd_ref.params.model_old:
        nd_ref.params.model_old = model
        
        # This should raise IndexError for invalid models
        nd_ref.params.model_name = plotters[model].model_name   # Apply model-specific values
        nd_ref.params.travel_x = plotters[model].travel_x
        nd_ref.params.travel_y = plotters[model].travel_y
        nd_ref.params.jerk_derate = plotters[model].jerk_derate
        nd_ref.params.auto_home = plotters[model].auto_home
        nd_ref.params.z_motor = plotters[model].z_motor

        if nd_ref.options.penlift == 3:     # Brushless upgrade specified in options.
            nd_ref.params.z_motor = 1


    handling = nd_ref.options.handling
    if (handling != 0) and (handling != nd_ref.params.handling_old):
        nd_ref.params.handling_old = handling

        nd_ref.params.resolution = handlers[handling].resolution
        nd_ref.params.jerk_pen_down = handlers[handling].jerk * nd_ref.params.jerk_derate
        nd_ref.params.const_speed = bool(handlers[handling].jerk == 0)
        nd_ref.params.curve_tolerance = handlers[handling].tolerance

        if nd_ref.params.resolution == 2: # low res
            nd_ref.params.speed_limit =\
                min(handlers[handling].speed, nd_ref.params.speed_lim_xy_lr)
            nd_ref.params.speed_up =\
                min(handlers[handling].speed_up, nd_ref.params.speed_lim_xy_lr)
        else:   # High res (adn other cases?)
            nd_ref.params.speed_limit =\
                min(handlers[handling].speed, nd_ref.params.speed_lim_xy_hr)
            nd_ref.params.speed_up =\
                min(handlers[handling].speed_up, nd_ref.params.speed_lim_xy_hr)

    if nd_ref.params.resolution == 2: # low res
        nd_ref.params.jerk_pen_up = plotters[model].jerk_pen_up_lo
    else:
        nd_ref.params.jerk_pen_up = plotters[model].jerk_pen_up_hi

    # Apply any overrides:
    if nd_ref.params.overrides['model_name'] is not None:
        nd_ref.params.model_name = nd_ref.params.overrides['model_name']
    if nd_ref.params.overrides['travel_x'] is not None:
        nd_ref.params.travel_x = nd_ref.params.overrides['travel_x']
    if nd_ref.params.overrides['travel_y'] is not None:
        nd_ref.params.travel_y = nd_ref.params.overrides['travel_y']
    if nd_ref.params.overrides['jerk_pen_up'] is not None:
        nd_ref.params.jerk_pen_up = nd_ref.params.overrides['jerk_pen_up']
    if nd_ref.params.overrides['auto_home'] is not None:
        nd_ref.params.auto_home = nd_ref.params.overrides['auto_home']

    if nd_ref.params.overrides['resolution'] is not None:
        nd_ref.params.resolution = nd_ref.params.overrides['resolution']
    if nd_ref.params.overrides['curve_tolerance'] is not None:
        nd_ref.params.curve_tolerance = nd_ref.params.overrides['curve_tolerance']
    if nd_ref.params.overrides['const_speed'] is not None:
        nd_ref.params.const_speed = nd_ref.params.overrides['const_speed']
    if nd_ref.params.overrides['jerk_pen_down'] is not None:
        nd_ref.params.jerk_pen_down = nd_ref.params.overrides['jerk_pen_down']
    if nd_ref.params.overrides['speed_limit'] is not None:
        nd_ref.params.speed_limit = nd_ref.params.overrides['speed_limit']

    if nd_ref.params.overrides['z_motor'] is not None:
        nd_ref.params.z_motor = nd_ref.params.overrides['z_motor']

    z_motor = nd_ref.params.z_motor
    if z_motor != nd_ref.params.z_motor_old:
        nd_ref.params.z_motor_old = z_motor

        nd_ref.params.servo_pin = z_motors[z_motor].pin # Apply servo-specific values
        nd_ref.params.servo_max = z_motors[z_motor].max
        nd_ref.params.servo_min = z_motors[z_motor].min
        nd_ref.params.servo_sweep_time = z_motors[z_motor].sweep_time
        nd_ref.params.servo_move_min = z_motors[z_motor].move_min
        nd_ref.params.servo_move_slope = z_motors[z_motor].move_slope

    # Apply any overrides to servo parameters.
    if nd_ref.params.overrides['servo_pin'] is not None:
        nd_ref.params.servo_pin = nd_ref.params.overrides['servo_pin']
    if nd_ref.params.overrides['servo_max'] is not None:
        nd_ref.params.servo_max = nd_ref.params.overrides['servo_max']
    if nd_ref.params.overrides['servo_min'] is not None:
        nd_ref.params.servo_min = nd_ref.params.overrides['servo_min']
    if nd_ref.params.overrides['servo_sweep_time'] is not None:
        nd_ref.params.servo_sweep_time = nd_ref.params.overrides['servo_sweep_time']
    if nd_ref.params.overrides['servo_move_min'] is not None:
        nd_ref.params.servo_move_min = nd_ref.params.overrides['servo_move_min']
    if nd_ref.params.overrides['servo_move_slope'] is not None:
        nd_ref.params.servo_move_slope = nd_ref.params.overrides['servo_move_slope']


def find_curve_tolerance(nd_ref, handling_mode):
    '''
    Find the curve tolerance value, for a specific handling mode, and applying
    overrides to that value, if so-configured.
    '''

    if handling_mode not in [1, 2, 3, 4]:
        return None

    curve_tolerance = handlers[handling_mode].tolerance

    if nd_ref.params.overrides['curve_tolerance'] is not None:
        curve_tolerance = nd_ref.params.overrides['curve_tolerance']
    return curve_tolerance
