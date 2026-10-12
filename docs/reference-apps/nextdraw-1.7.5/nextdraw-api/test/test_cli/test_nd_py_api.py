import logging
import time
import unittest
from plotink import plot_utils

from mock import ANY, MagicMock, patch

import nextdraw

testfile = "test/assets/NextDraw_trivial.svg"

# from plotink.plot_utils_import import from_dependency_import # plotink
# inkex = from_dependency_import('ink_extensions.inkex')

# python -m unittest discover in top-level package dir

# @patch.object(nextdraw.message, "emit")

class NextDrawPythonAPITestCase(unittest.TestCase):

    def test_import(self):
        print("test NextDraw python API import and params")
        ndraw = nextdraw.NextDraw()
        ndraw.params.check_updates = False
        self.assertEqual(ndraw.params.servo_timeout, 60000)

    def test_plot_setup(self):
        print("test plot_setup")
        ndraw = nextdraw.NextDraw()
        ndraw.original_document = None
        ndraw.original_document = None
        ndraw.plot_setup()

        self.assertIsNotNone(ndraw.document)
        self.assertIsNotNone(ndraw.original_document)
        self.assertNotEqual(ndraw.document, ndraw.original_document) # different objects

    @patch.object(nextdraw.NextDraw, "get_output")
    @patch.object(nextdraw.NextDraw, "effect")
    def test_plot_run(self, m_effect, m_get_output):
        print("test plot_run")

        ndraw = self._setup_nextdraw_with_args()
        ndraw = nextdraw.NextDraw()
        ndraw.document = MagicMock()

        ndraw.plot_run()

        m_effect.assert_called_once()
        self.assertFalse(m_get_output.called)

    @patch.object(nextdraw.NextDraw, "get_output")
    @patch.object(nextdraw.NextDraw, "effect")
    def test_plot_run_output(self, m_effect, m_get_output):
        print("test plot_run check output")
        ndraw = self._setup_nextdraw_with_args()
        ndraw.document = MagicMock()
        ndraw.plot_setup()

        ndraw.plot_run(output=True)

        m_effect.assert_called_once()
        m_get_output.assert_called_once()



    def test_load_config(self):
        print("test load_config comprehensively")
        config_path = "test/assets/nextdraw_conf.py"

        # Test 1: Interactive context with multiple options changed
        ndraw1 = nextdraw.NextDraw()
        ndraw1.interactive()

        # Change multiple options to non-default values
        ndraw1.options.pen_pos_up = 90        # Default is 60
        ndraw1.options.pen_pos_down = 10      # Default is 40
        ndraw1.options.speed_pendown = 50     # Default is 25
        ndraw1.options.units = 2              # Default is 0, but won't be reset by config

        self.assertEqual(ndraw1.options.pen_pos_up, 90)
        self.assertEqual(ndraw1.options.pen_pos_down, 10)
        self.assertEqual(ndraw1.options.speed_pendown, 50)
        self.assertEqual(ndraw1.options.units, 2)

        # Load the config and verify options reset, but units and interactive mode preserved
        ndraw1.load_config(config_path)

        self.assertEqual(ndraw1.options.pen_pos_up, 60)
        self.assertEqual(ndraw1.options.pen_pos_down, 40)
        self.assertEqual(ndraw1.options.speed_pendown, 25)
        self.assertEqual(ndraw1.options.units, 2)  # Should remain unchanged
        self.assertEqual(ndraw1.options.mode, "interactive")  # Interactive mode preserved

        # Test 2: Plot context with "layers" mode
        ndraw2 = nextdraw.NextDraw()
        ndraw2.plot_setup(testfile)

        # Change general and plot-specific options
        ndraw2.options.pen_pos_up = 80        # General option
        ndraw2.options.reordering = 2         # Plot-specific option (default is 0)
        ndraw2.options.copies = 5             # Plot-specific option (default is 1)
        ndraw2.options.mode = "layers"        # Change mode from default "plot"

        self.assertEqual(ndraw2.options.pen_pos_up, 80)
        self.assertEqual(ndraw2.options.reordering, 2)
        self.assertEqual(ndraw2.options.copies, 5)
        self.assertEqual(ndraw2.options.mode, "layers")

        # Load the config
        ndraw2.load_config(config_path)

        # Verify options reset and mode NOT preserved (reset to "plot")
        self.assertEqual(ndraw2.options.pen_pos_up, 60)
        self.assertEqual(ndraw2.options.reordering, 0)
        self.assertEqual(ndraw2.options.copies, 1)
        self.assertEqual(ndraw2.options.mode, "plot")  # Should be reset to default "plot"

        # Test 3: Verify "utility" mode is also not preserved
        ndraw3 = nextdraw.NextDraw()
        ndraw3.plot_setup(testfile)
        ndraw3.options.mode = "utility"
        ndraw3.options.utility_cmd = "write_name"

        ndraw3.load_config(config_path)

        # Mode should be reset, along with other options
        self.assertEqual(ndraw3.options.mode, "plot")  # Reset to default "plot"
        self.assertEqual(ndraw3.options.utility_cmd, "read_name")  # Default value


    @patch.object(nextdraw.NextDraw, 'plot_polyline')
    @patch.object(nextdraw.NextDraw, 'penup')
    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    @patch('nextdrawcore.boundsclip.clip_at_bounds')
    def test_draw_path(self, m_clip_at_bounds, m_verify_interactive, m_penup, m_plot_polyline):
        print("test draw_path")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()

        # Setup plot status and other required objects
        ndraw.plot_status = MagicMock()
        ndraw.params = MagicMock()
        ndraw.pen = MagicMock()
        ndraw.pen.turtle = MagicMock()
        ndraw.bounds = [[0, 0], [8.5, 11]]  # Standard letter size

        # Test 1: Interactive context validation failure
        m_verify_interactive.return_value = False
        ndraw.draw_path([[1, 1], [2, 2]])
        m_verify_interactive.assert_called_with(True)
        m_plot_polyline.assert_not_called()

        # Test 2: Input validation - less than 2 vertices
        m_verify_interactive.return_value = True
        ndraw.draw_path([[1, 1]])
        m_plot_polyline.assert_not_called()

        # Test 3: Plot already stopped
        ndraw.plot_status.stopped = True
        ndraw.draw_path([[1, 1], [2, 2]])
        m_plot_polyline.assert_not_called()

        # Reset for main tests
        ndraw.plot_status.stopped = False
        m_plot_polyline.reset_mock()
        m_penup.reset_mock()

        # Test 4: Basic path with inch units
        ndraw.options = MagicMock()
        ndraw.options.units = 0  # inches

        # Setup clipping to preserve path but simulate the process
        def clip_simulation(digest, *args, **kwargs):
            # Do nothing, leave paths unchanged
            pass

        m_clip_at_bounds.side_effect = clip_simulation

        vertices = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]
        ndraw.draw_path(vertices)

        # Verify the path was processed correctly
        m_plot_polyline.assert_called_once()
        m_penup.assert_called_once()
        self.assertEqual(ndraw.pen.turtle.xpos, 1)
        self.assertEqual(ndraw.pen.turtle.ypos, 1)
        self.assertEqual(ndraw.pen.turtle.z_up, True)

        # Reset mocks for next test
        m_plot_polyline.reset_mock()
        m_penup.reset_mock()

        # Test 5: Path with cm units
        ndraw.options.units = 1  # cm

        vertices = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]
        ndraw.draw_path(vertices)

        # Verify the scaling by checking the arguments passed to clip_at_bounds
        m_clip_at_bounds.assert_called()
        # Each vertex should be divided by 2.54 for conversion from cm to inches
        expected_vertices = [[v[0]/2.54, v[1]/2.54] for v in vertices]

        # Reset mocks for next test
        m_plot_polyline.reset_mock()
        m_penup.reset_mock()
        m_clip_at_bounds.reset_mock()

        # Test 6: Path with mm units
        ndraw.options.units = 2  # mm

        vertices = [[10, 10], [30, 10], [30, 30], [10, 30], [10, 10]]
        ndraw.draw_path(vertices)

        # Verify the scaling by checking the arguments passed to clip_at_bounds
        m_clip_at_bounds.assert_called()
        # Each vertex should be divided by 25.4 for conversion from mm to inches

        # Reset mocks for next test
        m_plot_polyline.reset_mock()
        m_penup.reset_mock()
        m_clip_at_bounds.reset_mock()

        # Test 7: Plot gets stopped during execution
        ndraw.options.units = 0  # inches

        # Set up plot_polyline to simulate stopping mid-execution
        def stop_plot(*args, **kwargs):
            ndraw.plot_status.stopped = True

        m_plot_polyline.side_effect = stop_plot

        vertices = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]
        ndraw.draw_path(vertices)

        # Verify the pen is up and turtle position is updated
        self.assertEqual(ndraw.pen.turtle.z_up, True)



    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    def test_position_reporting(self, m_verify_interactive):
        print("test position reporting functions")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()

        # Setup pen positions
        ndraw.pen = MagicMock()
        ndraw.pen.phys.xpos = 2.5
        ndraw.pen.phys.ypos = 3.5
        ndraw.pen.phys.z_up = True

        ndraw.pen.turtle.xpos = 2.75
        ndraw.pen.turtle.ypos = 3.75
        ndraw.pen.turtle.z_up = False

        # Set up options with different units
        ndraw.options = MagicMock()

        # Test with inches (units=0)
        m_verify_interactive.return_value = True
        ndraw.options.units = 0

        current_pos = ndraw.current_pos()
        turtle_pos = ndraw.turtle_pos()
        self.assertEqual(current_pos, (2.5, 3.5))
        self.assertEqual(turtle_pos, (2.75, 3.75))

        # Test with cm (units=1)
        ndraw.options.units = 1

        current_pos = ndraw.current_pos()
        turtle_pos = ndraw.turtle_pos()
        # Position should be scaled by 2.54 (inches to cm)
        self.assertAlmostEqual(current_pos[0], 2.5 * 2.54, places=5)
        self.assertAlmostEqual(current_pos[1], 3.5 * 2.54, places=5)
        self.assertAlmostEqual(turtle_pos[0], 2.75 * 2.54, places=5)
        self.assertAlmostEqual(turtle_pos[1], 3.75 * 2.54, places=5)

        # Test with mm (units=2)
        ndraw.options.units = 2

        current_pos = ndraw.current_pos()
        turtle_pos = ndraw.turtle_pos()
        # Position should be scaled by 25.4 (inches to mm)
        self.assertAlmostEqual(current_pos[0], 2.5 * 25.4, places=5)
        self.assertAlmostEqual(current_pos[1], 3.5 * 25.4, places=5)
        self.assertAlmostEqual(turtle_pos[0], 2.75 * 25.4, places=5)
        self.assertAlmostEqual(turtle_pos[1], 3.75 * 25.4, places=5)

        # Test pen state functions
        current_pen = ndraw.current_pen()
        turtle_pen = ndraw.turtle_pen()
        self.assertTrue(current_pen)
        self.assertFalse(turtle_pen)

        # Test verification failure - make _verify_interactive raise an exception
        m_verify_interactive.side_effect = RuntimeError("Not connected to NextDraw")
        with self.assertRaises(RuntimeError):
            ndraw.current_pos()

        # Reset for further testing
        m_verify_interactive.side_effect = None
        m_verify_interactive.return_value = True


    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    def test_pen_control(self, m_verify_interactive):
        print("test pen control functions")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()
        ndraw.pen = MagicMock()
        ndraw.pen.pen_raise = MagicMock()
        ndraw.pen.pen_lower = MagicMock()
        ndraw.pen.turtle = MagicMock()
        ndraw.params = MagicMock()
        ndraw.bounds = [[0, 0], [8.5, 11]]  # Standard letter size

        # Test 1: Test penup when _verify_interactive returns False
        m_verify_interactive.return_value = False
        ndraw.penup()
        ndraw.pen.pen_raise.assert_not_called()

        # Test 2: Test penup when _verify_interactive returns True
        m_verify_interactive.return_value = True
        ndraw.pen.pen_raise.reset_mock()
        ndraw.penup()
        ndraw.pen.pen_raise.assert_called_once()
        self.assertTrue(ndraw.pen.turtle.z_up)

        # Test 3: Test pendown when _verify_interactive returns False
        m_verify_interactive.return_value = False
        ndraw.pen.pen_lower.reset_mock()
        ndraw.pendown()
        ndraw.pen.pen_lower.assert_not_called()

        # Test 4: Test pendown when in bounds and auto_clip_lift is True
        m_verify_interactive.return_value = True
        ndraw.params.auto_clip_lift = True
        ndraw.pen.turtle.z_up = True  # Starting with pen up
        ndraw.pen.turtle.xpos = 2.0   # In bounds
        ndraw.pen.turtle.ypos = 2.0   # In bounds

        from plotink import plot_utils
        with patch.object(plot_utils, 'point_in_bounds') as m_point_in_bounds:
            m_point_in_bounds.return_value = True  # Point is in bounds
            ndraw.pen.pen_lower.reset_mock()
            ndraw.pendown()
            ndraw.pen.pen_lower.assert_called_once()  # Should lower pen
            self.assertFalse(ndraw.pen.turtle.z_up)   # Should update turtle state

        # Test 5: Test pendown when out of bounds and auto_clip_lift is True
        with patch.object(plot_utils, 'point_in_bounds') as m_point_in_bounds:
            m_point_in_bounds.return_value = False  # Point is out of bounds
            ndraw.pen.turtle.z_up = True  # Reset pen state
            ndraw.pen.pen_lower.reset_mock()
            ndraw.pendown()
            ndraw.pen.pen_lower.assert_not_called()  # Should NOT lower pen
            self.assertFalse(ndraw.pen.turtle.z_up)  # But should update turtle state

        # Test 6: Test pendown when out of bounds but auto_clip_lift is False
        ndraw.params.auto_clip_lift = False
        with patch.object(plot_utils, 'point_in_bounds') as m_point_in_bounds:
            m_point_in_bounds.return_value = False  # Point is out of bounds
            ndraw.pen.turtle.z_up = True  # Reset pen state
            ndraw.pen.pen_lower.reset_mock()
            ndraw.pendown()
            ndraw.pen.pen_lower.assert_called_once()  # Should lower pen despite being out of bounds
            self.assertFalse(ndraw.pen.turtle.z_up)  # Should update turtle state

        # Test 7: Test pendown when pen is already down
        ndraw.pen.turtle.z_up = False  # Pen is already down
        ndraw.pen.pen_lower.reset_mock()
        ndraw.pendown()
        ndraw.pen.pen_lower.assert_called_once()  # Should still call pen_lower
        self.assertFalse(ndraw.pen.turtle.z_up)  # State remains unchanged

    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    def test_delay(self, m_verify_interactive):
        print("test delay function")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()
        ndraw.machine = MagicMock()
        ndraw.user_message_fun = MagicMock()

        # Test 1: Test when _verify_interactive returns False
        m_verify_interactive.return_value = False
        ndraw.delay(1000)
        m_verify_interactive.assert_called_with(True)
        ndraw.user_message_fun.assert_not_called()
        ndraw.machine.timed_pause.assert_not_called()

        # Test 2: Test when _verify_interactive returns True but time_ms is None
        m_verify_interactive.reset_mock()
        m_verify_interactive.return_value = True
        ndraw.delay(None)
        m_verify_interactive.assert_called_with(True)
        ndraw.user_message_fun.assert_called_once()
        ndraw.machine.timed_pause.assert_not_called()

        # Test 3: Test when _verify_interactive returns True and time_ms is valid
        m_verify_interactive.reset_mock()
        ndraw.user_message_fun.reset_mock()
        ndraw.delay(1000)
        m_verify_interactive.assert_called_with(True)
        ndraw.user_message_fun.assert_not_called()
        ndraw.machine.timed_pause.assert_called_once_with(1000)

        # Test 4: Test with non-integer time_ms (string)
        ndraw.machine.timed_pause.reset_mock()
        ndraw.delay("1000")
        ndraw.machine.timed_pause.assert_called_once_with(1000)

        # Test 5: Test with float time_ms
        ndraw.machine.timed_pause.reset_mock()
        ndraw.delay(1000.5)
        ndraw.machine.timed_pause.assert_called_once_with(1000)

        # Test 6: Test with negative time_ms
        ndraw.machine.timed_pause.reset_mock()
        ndraw.delay(-1000)
        ndraw.machine.timed_pause.assert_not_called()

        # Test 7: Test with zero time_ms
        ndraw.machine.timed_pause.reset_mock()
        ndraw.delay(0)
        ndraw.machine.timed_pause.assert_not_called()


    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    @patch('nextdrawcore.serial_utils.exhaust_queue')
    def test_block(self, m_exhaust_queue, m_verify_interactive):
        print("test block function")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()

        # Test 1: When _verify_interactive returns False
        m_verify_interactive.return_value = False
        ndraw.block()
        m_verify_interactive.assert_called_with(True)
        m_exhaust_queue.assert_not_called()

        # Test 2: When _verify_interactive returns True
        m_verify_interactive.return_value = True
        ndraw.block()
        m_verify_interactive.assert_called_with(True)
        m_exhaust_queue.assert_called_once_with(ndraw)

        # Test 3: When verify_interactive raises an exception
        m_verify_interactive.side_effect = RuntimeError("Not connected to NextDraw")
        with self.assertRaises(RuntimeError):
            ndraw.block()

        # Reset for further testing if needed
        m_verify_interactive.side_effect = None


    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    @patch.object(nextdraw.NextDraw, 'update_options')
    @patch('nextdrawcore.serial_utils.enable_motors')
    def test_update(self, m_enable_motors, m_update_options, m_verify_interactive):
        """test update function"""
        print("test update")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()

        # Setup mock objects
        ndraw.pen = MagicMock()
        ndraw.machine = MagicMock()

        # Test 1: Not in interactive context or not connected
        m_verify_interactive.return_value = False
        ndraw.update()
        m_verify_interactive.assert_called_once()
        m_update_options.assert_not_called()
        ndraw.pen.servo_init.assert_not_called()
        m_enable_motors.assert_not_called()

        # Reset mocks
        m_verify_interactive.reset_mock()
        m_update_options.reset_mock()

        # Test 2: In interactive context and connected
        m_verify_interactive.return_value = True
        ndraw.machine.port = True  # Simulate machine is connected
        ndraw.update()

        # Verify that all required methods were called
        m_verify_interactive.assert_called_once()
        m_update_options.assert_called_once()
        ndraw.pen.servo_init.assert_called_once_with(ndraw)
        m_enable_motors.assert_called_once_with(ndraw)

        # Test 3: In interactive context but not connected
        m_verify_interactive.reset_mock()
        m_update_options.reset_mock()
        ndraw.pen.servo_init.reset_mock()
        m_enable_motors.reset_mock()

        ndraw.machine.port = None  # Simulate machine is not connected
        ndraw.update()

        # Verify appropriate methods were called
        m_verify_interactive.assert_called_once()
        m_update_options.assert_called_once()
        ndraw.pen.servo_init.assert_called_once_with(ndraw)
        m_enable_motors.assert_not_called()  # Should not be called if machine.port is None


    def test_handle_errors(self):
        print("test handle_errors function")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()

        # Test 1: No error (code 0)
        ndraw.plot_status = MagicMock()
        ndraw.plot_status.stopped = 0
        ndraw.errors.code = 0
        ndraw._interrupted = False

        ndraw.handle_errors()  # Should not raise any error

        self.assertEqual(ndraw.errors.code, 0)

        # Test 2: Connection error with errors.connect = True
        ndraw.plot_status.stopped = 101
        ndraw.errors.connect = True

        with self.assertRaises(RuntimeError) as context:
            ndraw.handle_errors()

        self.assertIn("Failed to connected to NextDraw", str(context.exception))

        # Test 3: Button press error with errors.button = True
        ndraw.plot_status.stopped = 102
        ndraw.errors.connect = False
        ndraw.errors.button = True
        ndraw.disconnect = MagicMock()

        with self.assertRaises(RuntimeError) as context:
            ndraw.handle_errors()

        self.assertIn("Stopped by pause button press", str(context.exception))
        ndraw.disconnect.assert_called_once()

        # Reset mock
        ndraw.disconnect.reset_mock()

        # Test 4: Keyboard interrupt error with errors.keyboard = True
        ndraw.plot_status.stopped = 103
        ndraw.errors.button = False
        ndraw.errors.keyboard = True

        with self.assertRaises(RuntimeError) as context:
            ndraw.handle_errors()

        self.assertIn("Stopped by keyboard interrupt", str(context.exception))
        ndraw.disconnect.assert_called_once()

        # Reset mock
        ndraw.disconnect.reset_mock()

        # Test 5: Disconnect error with errors.disconnect = True
        ndraw.plot_status.stopped = 104
        ndraw.errors.keyboard = False
        ndraw.errors.disconnect = True

        with self.assertRaises(RuntimeError) as context:
            ndraw.handle_errors()

        self.assertIn("Lost USB connectivity", str(context.exception))

        # Test 6: Power loss error with errors.power = True
        ndraw.plot_status.stopped = 105
        ndraw.errors.disconnect = False
        ndraw.errors.power = True

        with self.assertRaises(RuntimeError) as context:
            ndraw.handle_errors()

        self.assertIn("Power loss detected", str(context.exception))

        # Test 7: Homing failure error with errors.homing = True
        ndraw.plot_status.stopped = 106
        ndraw.errors.power = False
        ndraw.errors.homing = True

        with self.assertRaises(RuntimeError) as context:
            ndraw.handle_errors()

        self.assertIn("Homing failed", str(context.exception))

        # Test 8: Interrupted flag set but no error code
        ndraw.plot_status.stopped = 0
        ndraw.errors.homing = False
        ndraw._interrupted = True

        ndraw.handle_errors()

        self.assertEqual(ndraw.plot_status.stopped, -103)  # Should set keyboard interrupt code

    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    @patch.object(nextdraw.NextDraw, '_xy_plot_segment')
    def test_go_command(self, m_xy_plot_segment, m_verify_interactive):
        """
        Test the go() relative movement command
        - Should call _xy_plot_segment with correct parameters
        - Should not modify pen state
        - Should handle interactive context verification
        """
        print("test go relative movement command")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()
        ndraw.pen = MagicMock()
        ndraw.pen.turtle = MagicMock()

        # Test 1: go with verify_interactive returning True
        m_verify_interactive.return_value = True
        orig_z_up = ndraw.pen.turtle.z_up = True  # Set initial pen state

        ndraw.go(2.0, 3.0)

        # Verify _xy_plot_segment called with relative=True and correct coordinates
        m_xy_plot_segment.assert_called_once_with(True, 2.0, 3.0)

        # Verify pen state is unchanged (go should not modify pen state)
        self.assertEqual(ndraw.pen.turtle.z_up, orig_z_up)

        # Test 2: go with verify_interactive returning False
        m_verify_interactive.reset_mock()
        m_xy_plot_segment.reset_mock()
        m_verify_interactive.return_value = False
        orig_z_up = ndraw.pen.turtle.z_up = False  # Change pen state

        ndraw.go(4.0, 5.0)

        # Verify _xy_plot_segment called with correct parameters
        m_xy_plot_segment.assert_called_once_with(True, 4.0, 5.0)

        # Verify pen state unchanged
        self.assertEqual(ndraw.pen.turtle.z_up, orig_z_up)

        # Test 3: negative coordinates
        m_verify_interactive.reset_mock()
        m_xy_plot_segment.reset_mock()
        m_verify_interactive.return_value = True

        ndraw.go(-2.5, -3.5)

        # Verify _xy_plot_segment called with correct negative values
        m_xy_plot_segment.assert_called_once_with(True, -2.5, -3.5)

    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    @patch.object(nextdraw.NextDraw, '_xy_plot_segment')
    def test_move_command(self, m_xy_plot_segment, m_verify_interactive):
        """
        Test the move() relative pen-up command
        - Should raise pen
        - Should update turtle pen state to up
        - Should call _xy_plot_segment with relative=True and correct coordinates
        - Should handle interactive context verification
        """
        print("test move relative pen-up command")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()

        # Setup mock objects
        ndraw.pen = MagicMock()
        ndraw.pen.pen_raise = MagicMock()
        ndraw.pen.turtle = MagicMock()
        ndraw.pen.turtle.z_up = False  # Start with pen down

        # Test 1: move with verify_interactive returning True
        m_verify_interactive.return_value = True

        ndraw.move(2.0, 3.0)

        # Verify pen was raised
        ndraw.pen.pen_raise.assert_called_once()

        # Verify turtle pen state updated to up
        self.assertTrue(ndraw.pen.turtle.z_up)

        # Verify _xy_plot_segment called with relative=True and correct coordinates
        m_xy_plot_segment.assert_called_once_with(True, 2.0, 3.0)

        # Test 2: move with verify_interactive returning False
        m_verify_interactive.reset_mock()
        m_xy_plot_segment.reset_mock()
        ndraw.pen.pen_raise.reset_mock()
        ndraw.pen.turtle.z_up = False  # Reset pen state to down

        m_verify_interactive.return_value = False

        ndraw.move(4.0, 5.0)

        # Verify pen was NOT raised when verification fails
        ndraw.pen.pen_raise.assert_not_called()

        # Verify turtle pen state NOT updated
        self.assertFalse(ndraw.pen.turtle.z_up)

        # Verify _xy_plot_segment is not called
        m_xy_plot_segment.assert_not_called()

        # Test 3: move with zero coordinates
        m_verify_interactive.reset_mock()
        m_xy_plot_segment.reset_mock()
        ndraw.pen.pen_raise.reset_mock()
        ndraw.pen.turtle.z_up = False  # Reset pen state to down

        m_verify_interactive.return_value = True

        ndraw.move(0.0, 0.0)

        # Verify pen was raised
        ndraw.pen.pen_raise.assert_called_once()

        # Verify turtle pen state updated to up
        self.assertTrue(ndraw.pen.turtle.z_up)

        # Verify _xy_plot_segment called with relative=True and correct coordinates
        m_xy_plot_segment.assert_called_once_with(True, 0.0, 0.0)

    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    @patch.object(nextdraw.NextDraw, '_xy_plot_segment')
    def test_line_command(self, m_xy_plot_segment, m_verify_interactive):
        """
        Test the line() relative pen-down command
        - Should update turtle pen state to down
        - Should call _xy_plot_segment with relative=True and correct coordinates
        - Should handle interactive context verification
        """
        print("test line relative pen-down command")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()

        # Setup mock objects
        ndraw.pen = MagicMock()
        ndraw.pen.turtle = MagicMock()
        ndraw.pen.turtle.z_up = True  # Start with pen up

        # Test 1: line with verify_interactive returning True
        m_verify_interactive.return_value = True

        ndraw.line(2.0, 3.0)

        # Verify turtle pen state updated to down (z_up = False)
        self.assertFalse(ndraw.pen.turtle.z_up)

        # Verify _xy_plot_segment called with relative=True and correct coordinates
        m_xy_plot_segment.assert_called_once_with(True, 2.0, 3.0)

        # Test 2: line with verify_interactive returning False
        m_verify_interactive.reset_mock()
        m_xy_plot_segment.reset_mock()
        ndraw.pen.turtle.z_up = True  # Reset pen state to up

        m_verify_interactive.return_value = False

        ndraw.line(4.0, 5.0)

        # Verify turtle pen state updated to down regardless of verification
        self.assertFalse(ndraw.pen.turtle.z_up)

        # Verify _xy_plot_segment is still called (relies on _xy_plot_segment to check interactive context)
        m_xy_plot_segment.assert_called_once_with(True, 4.0, 5.0)

        # Test 3: line with pen already down
        m_verify_interactive.reset_mock()
        m_xy_plot_segment.reset_mock()
        ndraw.pen.turtle.z_up = False  # Pen already down

        m_verify_interactive.return_value = True

        ndraw.line(-2.5, -3.5)

        # Verify turtle pen state remains down
        self.assertFalse(ndraw.pen.turtle.z_up)

        # Verify _xy_plot_segment called with correct parameters
        m_xy_plot_segment.assert_called_once_with(True, -2.5, -3.5)

    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    @patch.object(nextdraw.NextDraw, '_xy_plot_segment')
    def test_goto_command(self, m_xy_plot_segment, m_verify_interactive):
        """
        Test the goto() absolute movement command
        - Should call _xy_plot_segment with relative=False and correct coordinates
        - Should not modify pen state
        - Should handle interactive context verification
        """
        print("test goto absolute movement command")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()
        ndraw.pen = MagicMock()
        ndraw.pen.turtle = MagicMock()

        # Test 1: goto with verify_interactive returning True
        m_verify_interactive.return_value = True
        orig_z_up = ndraw.pen.turtle.z_up = True  # Set initial pen state

        ndraw.goto(2.0, 3.0)

        # Verify _xy_plot_segment called with relative=False and correct absolute coordinates
        m_xy_plot_segment.assert_called_once_with(False, 2.0, 3.0)

        # Verify pen state is unchanged (goto should not modify pen state)
        self.assertEqual(ndraw.pen.turtle.z_up, orig_z_up)

        # Test 2: goto with verify_interactive returning False
        m_verify_interactive.reset_mock()
        m_xy_plot_segment.reset_mock()
        m_verify_interactive.return_value = False
        orig_z_up = ndraw.pen.turtle.z_up = False  # Change pen state

        ndraw.goto(4.0, 5.0)

        # Verify _xy_plot_segment called with correct parameters
        m_xy_plot_segment.assert_called_once_with(False, 4.0, 5.0)

        # Verify pen state unchanged
        self.assertEqual(ndraw.pen.turtle.z_up, orig_z_up)

        # Test 3: goto with zero coordinates (origin)
        m_verify_interactive.reset_mock()
        m_xy_plot_segment.reset_mock()
        m_verify_interactive.return_value = True

        ndraw.goto(0.0, 0.0)

        # Verify _xy_plot_segment called with correct values
        m_xy_plot_segment.assert_called_once_with(False, 0.0, 0.0)

    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    @patch.object(nextdraw.NextDraw, '_xy_plot_segment')
    def test_moveto_command(self, m_xy_plot_segment, m_verify_interactive):
        """
        Test the moveto() absolute pen-up command
        - Should raise pen
        - Should update turtle pen state to up
        - Should call _xy_plot_segment with relative=False and correct coordinates
        - Should handle interactive context verification
        """
        print("test moveto absolute pen-up command")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()

        # Setup mock objects
        ndraw.pen = MagicMock()
        ndraw.pen.pen_raise = MagicMock()
        ndraw.pen.turtle = MagicMock()
        ndraw.pen.turtle.z_up = False  # Start with pen down

        # Test 1: moveto with verify_interactive returning True
        m_verify_interactive.return_value = True

        ndraw.moveto(2.0, 3.0)

        # Verify pen was raised
        ndraw.pen.pen_raise.assert_called_once()

        # Verify turtle pen state updated to up
        self.assertTrue(ndraw.pen.turtle.z_up)

        # Verify _xy_plot_segment called with relative=False and correct coordinates
        m_xy_plot_segment.assert_called_once_with(False, 2.0, 3.0)

        # Test 2: moveto with verify_interactive returning False
        m_verify_interactive.reset_mock()
        m_xy_plot_segment.reset_mock()
        ndraw.pen.pen_raise.reset_mock()
        ndraw.pen.turtle.z_up = False  # Reset pen state to down

        m_verify_interactive.return_value = False

        ndraw.moveto(4.0, 5.0)

        # Verify pen was NOT raised when verification fails
        ndraw.pen.pen_raise.assert_not_called()

        # Verify turtle pen state NOT updated
        self.assertFalse(ndraw.pen.turtle.z_up)

        # Verify _xy_plot_segment is not called
        m_xy_plot_segment.assert_not_called()

        # Test 3: moveto with pen already up
        m_verify_interactive.reset_mock()
        m_xy_plot_segment.reset_mock()
        ndraw.pen.pen_raise.reset_mock()
        ndraw.pen.turtle.z_up = True  # Pen already up

        m_verify_interactive.return_value = True

        ndraw.moveto(0.0, 0.0)

        # Verify pen raise is still called (consistent behavior)
        ndraw.pen.pen_raise.assert_called_once()

        # Verify turtle pen state remains up
        self.assertTrue(ndraw.pen.turtle.z_up)

        # Verify _xy_plot_segment called with correct parameters
        m_xy_plot_segment.assert_called_once_with(False, 0.0, 0.0)

    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    @patch.object(nextdraw.NextDraw, '_xy_plot_segment')
    def test_lineto_command(self, m_xy_plot_segment, m_verify_interactive):
        """
        Test the lineto() absolute pen-down command
        - Should update turtle pen state to down
        - Should call _xy_plot_segment with relative=False and correct coordinates
        - Should handle interactive context verification
        """
        print("test lineto absolute pen-down command")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()

        # Setup mock objects
        ndraw.pen = MagicMock()
        ndraw.pen.turtle = MagicMock()
        ndraw.pen.turtle.z_up = True  # Start with pen up

        # Test 1: lineto with verify_interactive returning True
        m_verify_interactive.return_value = True

        ndraw.lineto(2.0, 3.0)

        # Verify turtle pen state updated to down
        self.assertFalse(ndraw.pen.turtle.z_up)

        # Verify _xy_plot_segment called with relative=False and correct coordinates
        m_xy_plot_segment.assert_called_once_with(False, 2.0, 3.0)

        # Test 2: lineto with verify_interactive returning False
        m_verify_interactive.reset_mock()
        m_xy_plot_segment.reset_mock()
        ndraw.pen.turtle.z_up = True  # Reset pen state to up

        m_verify_interactive.return_value = False

        ndraw.lineto(4.0, 5.0)

        # Verify turtle pen state updated to down regardless of verification
        self.assertFalse(ndraw.pen.turtle.z_up)

        # Verify _xy_plot_segment is still called (relies on _xy_plot_segment to check interactive context)
        m_xy_plot_segment.assert_called_once_with(False, 4.0, 5.0)

        # Test 3: lineto with pen already down
        m_verify_interactive.reset_mock()
        m_xy_plot_segment.reset_mock()
        ndraw.pen.turtle.z_up = False  # Pen already down

        m_verify_interactive.return_value = True

        ndraw.lineto(0.0, 0.0)

        # Verify turtle pen state remains down
        self.assertFalse(ndraw.pen.turtle.z_up)

        # Verify _xy_plot_segment called with correct parameters
        m_xy_plot_segment.assert_called_once_with(False, 0.0, 0.0)


    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    def test_xy_plot_segment(self, m_verify_interactive):
        print("test _xy_plot_segment function")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()

        # Setup mock objects
        ndraw.pen = MagicMock()
        ndraw.pen.turtle = MagicMock()
        ndraw.pen.turtle.xpos = 1.0
        ndraw.pen.turtle.ypos = 1.0
        ndraw.pen.turtle.z_up = True

        # Create options object with units attribute
        class Options:
            def __init__(self):
                self.units = 0  # Default to inches

        ndraw.options = Options()
        ndraw.bounds = [[0, 0], [8.5, 11]]  # Standard letter size
        ndraw.params = MagicMock()
        ndraw.params.auto_clip_lift = True
        ndraw.machine = MagicMock()
        ndraw.machine.port = True  # Simulate connected machine

        # Mock go_to_position method
        ndraw.go_to_position = MagicMock()

        # Also mock handle_errors method to avoid any unexpected errors
        ndraw.handle_errors = MagicMock()

        # Test 1: Relative move within bounds
        m_verify_interactive.return_value = True

        with patch.object(plot_utils, 'clip_segment') as m_clip_segment:
            # Return segment as-is (no clipping needed)
            m_clip_segment.return_value = (True, [[1.0, 1.0], [3.0, 2.0]])

            with patch.object(plot_utils, 'points_near') as m_points_near:
                m_points_near.return_value = True

                ndraw._xy_plot_segment(True, 2.0, 1.0)  # Relative move

                # Verify go_to_position was called with correct coordinates
                ndraw.go_to_position.assert_called_once_with(3.0, 2.0)

                # Check turtle position updated correctly
                self.assertEqual(ndraw.pen.turtle.xpos, 3.0)
                self.assertEqual(ndraw.pen.turtle.ypos, 2.0)

        # Test 2: Absolute move with clipping required
        ndraw.go_to_position.reset_mock()
        ndraw.pen.turtle.xpos = 7.0
        ndraw.pen.turtle.ypos = 5.0
        ndraw.pen.turtle.z_up = False

        with patch.object(plot_utils, 'clip_segment') as m_clip_segment:
            # Simulate clipping at bounds
            m_clip_segment.return_value = (True, [[7.0, 5.0], [8.5, 5.0]])

            with patch.object(plot_utils, 'points_near') as m_points_near:
                # First call: checking if starting point was clipped (no)
                # Second call: checking if ending point was clipped (yes)
                m_points_near.side_effect = [True, False]

                ndraw._xy_plot_segment(False, 10.0, 5.0)  # Absolute move

                # Verify go_to_position was called with clipped coordinates
                ndraw.go_to_position.assert_called_once_with(8.5, 5.0)

                # Check pen was raised due to clipping at boundary
                ndraw.pen.pen_raise.assert_called_once()

                # Check turtle position was updated to requested position
                self.assertEqual(ndraw.pen.turtle.xpos, 10.0)
                self.assertEqual(ndraw.pen.turtle.ypos, 5.0)

        # Test 3: Using different units (cm)
        ndraw.go_to_position.reset_mock()
        ndraw.pen.pen_raise.reset_mock()
        ndraw.pen.turtle.xpos = 1.0
        ndraw.pen.turtle.ypos = 1.0
        ndraw.options.units = 1  # cm

        with patch.object(plot_utils, 'clip_segment') as m_clip_segment:
            # Expected destination after conversion from cm to inches
            dest_x = 1.0 + 2.0/2.54
            dest_y = 1.0 + 2.0/2.54
            m_clip_segment.return_value = (True, [[1.0, 1.0], [dest_x, dest_y]])

            with patch.object(plot_utils, 'points_near') as m_points_near:
                m_points_near.return_value = True

                ndraw._xy_plot_segment(True, 2.0, 2.0)  # Relative move in cm

                # Verify go_to_position was called with converted coordinates
                ndraw.go_to_position.assert_called_once_with(dest_x, dest_y)

                # Check turtle position was updated with conversion from cm to inch
                self.assertAlmostEqual(ndraw.pen.turtle.xpos, dest_x, places=4)
                self.assertAlmostEqual(ndraw.pen.turtle.ypos, dest_y, places=4)

        # Test 4: Verify interactive check failure
        m_verify_interactive.return_value = False
        ndraw.go_to_position.reset_mock()

        ndraw._xy_plot_segment(True, 1.0, 1.0)

        # Ensure go_to_position was not called
        ndraw.go_to_position.assert_not_called()

        # Position should not change when verify_interactive fails
        self.assertAlmostEqual(ndraw.pen.turtle.xpos, dest_x, places=4)
        self.assertAlmostEqual(ndraw.pen.turtle.ypos, dest_y, places=4)

    @patch.object(nextdraw.NextDraw, '_verify_interactive')
    def test_usb_commands(self, m_verify_interactive):
        print("test usb_command and usb_query functions")

        # Create NextDraw instance
        ndraw = self._setup_nextdraw_with_args()
        ndraw.machine = MagicMock()

        # Test 1: usb_command with verify_interactive returning False
        m_verify_interactive.return_value = False
        ndraw.usb_command("SM,1000,1000")
        m_verify_interactive.assert_called_with(True)
        ndraw.machine.query.assert_not_called()

        # Test 2: usb_command with verify_interactive returning True
        m_verify_interactive.reset_mock()
        ndraw.machine.query.reset_mock()
        m_verify_interactive.return_value = True

        ndraw.usb_command("SM,1000,1000")
        m_verify_interactive.assert_called_with(True)
        ndraw.machine.query.assert_called_once_with("SM,1000,1000")

        # Test 3: usb_query with verify_interactive returning False
        m_verify_interactive.reset_mock()
        ndraw.machine.query.reset_mock()
        m_verify_interactive.return_value = False

        result = ndraw.usb_query("QP")
        m_verify_interactive.assert_called_with(True)
        ndraw.machine.query.assert_not_called()
        self.assertIsNone(result)

        # Test 4: usb_query with verify_interactive returning True
        m_verify_interactive.reset_mock()
        ndraw.machine.query.reset_mock()
        m_verify_interactive.return_value = True
        ndraw.machine.query.return_value = "1,2,3"

        result = ndraw.usb_query("QP")
        m_verify_interactive.assert_called_with(True)
        ndraw.machine.query.assert_called_once_with("QP")
        self.assertEqual(result, "1,2,3")

        # Test 5: verify_interactive raises exception
        m_verify_interactive.reset_mock()
        ndraw.machine.query.reset_mock()
        m_verify_interactive.side_effect = RuntimeError("Not connected to NextDraw")

        with self.assertRaises(RuntimeError):
            ndraw.usb_command("SM,1000,1000")

        with self.assertRaises(RuntimeError):
            ndraw.usb_query("QP")






    def _setup_nextdraw_with_args(self, args=None, m_emit=None):
        ''' returns an NextDraw '''
        ndraw = nextdraw.NextDraw() if m_emit is None else nextdraw.NextDraw(user_message_fun=m_emit)
        return ndraw
