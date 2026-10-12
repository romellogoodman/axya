from mock import patch
import sys

from pyfakefs.fake_filesystem import PatchMode
from pyfakefs.fake_filesystem_unittest import TestCase

from nextdrawcore import nextdraw

from nextdraw import nextdraw_cli

# python -m unittest discover in top-level package dir

class NextDrawCliTestCase(TestCase):

    def setUp(self):
        self.setUpPyfakefs(patch_open_code=PatchMode.AUTO)
        self.fs.add_real_file('./test/assets/NextDraw_trivial.svg', target_path='NextDraw_trivial.svg')

        sys.argv = ['nextdraw', 'NextDraw_trivial.svg', '--preview']


    # Commenting out these test cases; not sure if this is a general issue with the CLI or whether it is with the tests
    # https://github.com/bantamtools/nextdraw-api/issues/29


    def test_cli_options(self):
        """ Options set via the command line override options set in the default config file """
        ndc = nextdraw_cli.nextdraw_CLI(dev=True)

        self.assertTrue(ndc.options.preview) # overridden by the command line (see sys.argv)
        self.assertIn("speed_pendown", ndc.options.__dict__) # from the standard conf

    def test_cli_custom_conf_options(self):
        """ cli arguments override custom configs override default configs """
        self._setup_confpy( """
servo_timeout = 'willnotbeoverridden'
preview = False """)

        ndc = nextdraw_cli.nextdraw_CLI(dev=True)

        self.assertTrue(ndc.options.preview) # overridden by the command line (see sys.argv)
        self.assertEqual(ndc.params.servo_timeout, "willnotbeoverridden")

    @patch.object(nextdraw, "NextDraw")
    def test_noncli_conf_options(self, m_nextdraw):
        """ Some values used by nextdraw are configurable but not settable via command line. `nextdraw` grabs those values directly from the configurations, i.e. without an intermediary `options` object.  need to be properly sent to the NextDraw class and override configured values in the default config file. """
        # set up nextdraw mock
        attrs = {'plot_status.stopped': 0}
        m_nextdraw().configure_mock(**attrs)

        # test with config
        confpy_name = self._setup_confpy("""
speed_lim_xy_lr = 'testvalue'""")
        ndc = nextdraw_cli.nextdraw_CLI(dev=True)

        for call in m_nextdraw.call_args_list:
            if 'params' in call.kwargs:
                self.assertTrue(hasattr(call.kwargs['params'], 'speed_lim_xy_lr'))
                self.assertEqual(call.kwargs['params'].speed_lim_xy_lr, 'testvalue')
                self.assertTrue(hasattr(call.kwargs['params'], 'button_interval'), "the config 'module' must contain attributes that are in the default config but not the custom config")

                return

        self.fail("The NextDraw class must have been instantiated at least once with a params parameter. That params must have `speed_lim_xy_lr` and `speed_lim_xy_lr` must equal 'testvalue'")


    def _setup_confpy(self, confpy_contents, confpy_name = "custom_conf.py"):
        self.fs.create_file(confpy_name, contents = confpy_contents)
        sys.argv.extend(['--config', confpy_name])
        return confpy_name
