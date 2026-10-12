from .nextdraw_cli import nextdraw_CLI

try:
    from .strokefont_cli import strokefont_CLI
except ImportError as ie:
    if "strokefont" in str(ie):
        # this is probably ok, because it just means stroke font
        #   API is not included in this installation
        pass
    else:
        raise ie

def main():
    nextdraw_CLI()

if __name__ == '__main__':
    main()
